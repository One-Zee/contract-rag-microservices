import { createHash, generateKeyPairSync } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import type { AppConfigService } from '@app/config';
import { TokenService, parseDuration } from './token.service.js';
import type { RefreshTokensRepository } from './repositories/refresh-tokens.repository.js';

const ISSUER = 'clauseiq-auth';
const AUDIENCE = 'clauseiq-api';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const jwt = new JwtService({
  privateKey: keys.privateKey,
  publicKey: keys.publicKey,
  signOptions: {
    algorithm: 'RS256',
    expiresIn: '15m',
    issuer: ISSUER,
    audience: AUDIENCE,
  },
  verifyOptions: { algorithms: ['RS256'], issuer: ISSUER, audience: AUDIENCE },
});

const config = { refreshExpiresIn: '7d' } as AppConfigService;

const setup = () => {
  const repo = { create: vi.fn() };
  const service = new TokenService(
    jwt,
    config,
    repo as unknown as RefreshTokensRepository,
  );
  return { service, repo };
};

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
  ])('parses %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['15', 'm', '15 m', '1.5h', '15M', ''])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(/Invalid duration/);
  });
});

describe('TokenService', () => {
  describe('signAccessToken', () => {
    it('signs RS256 with the identity claims and the configured iss/aud', async () => {
      const { service } = setup();

      const token = await service.signAccessToken({
        id: 'u-1',
        email: 'ana@x.ba',
        role: 'analyst',
      });

      const header = JSON.parse(
        Buffer.from(token.split('.')[0], 'base64url').toString(),
      );
      expect(header.alg).toBe('RS256');

      const claims = jwt.verify<{
        sub: string;
        email: string;
        roles: string[];
        iss: string;
        aud: string;
        iat: number;
        exp: number;
      }>(token);
      expect(claims).toMatchObject({
        sub: 'u-1',
        email: 'ana@x.ba',
        iss: ISSUER,
        aud: AUDIENCE,
      });
      // an array even for one role, so the contract survives multi-role
      expect(claims.roles).toEqual(['analyst']);
      expect(claims.exp - claims.iat).toBe(900);
    });

    it('does not verify with a different public key', async () => {
      const { service } = setup();
      const foreign = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const token = await service.signAccessToken({
        id: 'u-1',
        email: 'ana@x.ba',
        role: 'reader',
      });

      expect(() =>
        new JwtService({
          publicKey: foreign.publicKey,
          verifyOptions: { algorithms: ['RS256'] },
        }).verify(token),
      ).toThrow();
    });
  });

  describe('mintRefreshToken', () => {
    it('produces 32 random bytes as base64url, hashed with SHA-256', () => {
      const { service } = setup();

      const minted = service.mintRefreshToken();

      // 32 bytes → 43 base64url characters, no padding
      expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(minted.tokenHash).toBe(
        createHash('sha256').update(minted.token).digest('hex'),
      );
      expect(minted.tokenHash).toBe(TokenService.hash(minted.token));
    });

    it('is not a JWT', () => {
      const { service } = setup();

      expect(service.mintRefreshToken().token.split('.')).toHaveLength(1);
    });

    it('expires REFRESH_EXPIRES_IN from now', () => {
      const { service } = setup();
      const before = Date.now();

      const { expiresAt } = service.mintRefreshToken();

      const ttl = expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(604_800_000 - 1_000);
      expect(ttl).toBeLessThanOrEqual(604_800_000 + 1_000);
    });

    it('never repeats', () => {
      const { service } = setup();

      const tokens = new Set(
        Array.from({ length: 50 }, () => service.mintRefreshToken().token),
      );

      expect(tokens.size).toBe(50);
    });
  });

  describe('issueRefreshToken', () => {
    it('stores the hash, returns the token', async () => {
      const { service, repo } = setup();
      repo.create.mockImplementation(async (row) => ({ ...row, id: 'rt-1' }));

      const issued = await service.issueRefreshToken('u-1');

      const stored = repo.create.mock.calls[0][0];
      expect(stored.userId).toBe('u-1');
      expect(stored.tokenHash).toBe(TokenService.hash(issued.token));
      expect(stored).not.toHaveProperty('token');
      expect(Object.values(stored)).not.toContain(issued.token);
      expect(issued.id).toBe('rt-1');
    });
  });

  describe('hash', () => {
    it('is deterministic SHA-256 hex', () => {
      expect(TokenService.hash('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      expect(TokenService.hash('abc')).toBe(TokenService.hash('abc'));
      expect(TokenService.hash('abd')).not.toBe(TokenService.hash('abc'));
    });
  });
});
