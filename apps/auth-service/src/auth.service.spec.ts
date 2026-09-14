import { Logger } from '@nestjs/common';
import type { RpcException } from '@nestjs/microservices';
import bcrypt from 'bcrypt';
import type { AuthContext, RpcErrorShape } from '@app/common';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import type {
  UserRecord,
  UsersRepository,
} from './repositories/users.repository.js';
import type {
  RefreshTokenRecord,
  RefreshTokensRepository,
} from './repositories/refresh-tokens.repository.js';

Logger.overrideLogger(false);

const PASSWORD = 'correct-horse-battery-staple';
const INVALID_CREDENTIALS = 'Invalid e-mail or password';

// bcrypt at cost 12 is ~250 ms; hashed once and shared by every test.
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 12);
});

const aUser = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  id: 'u-1',
  email: 'ana@x.ba',
  passwordHash,
  fullName: 'Ana',
  role: 'reader',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});

const aRefreshToken = (
  overrides: Partial<RefreshTokenRecord> = {},
): RefreshTokenRecord => ({
  id: 'rt-old',
  userId: 'u-1',
  tokenHash: TokenService.hash('old-token'),
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  replacedBy: null,
  createdAt: new Date(),
  ...overrides,
});

const asContext = (user: UserRecord): AuthContext => ({
  userId: user.id,
  email: user.email,
  roles: [user.role],
});

const errorOf = (e: unknown) => (e as RpcException).getError() as RpcErrorShape;

const setup = () => {
  const users = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
  };
  const refreshTokens = {
    create: vi.fn(),
    findByHash: vi.fn(),
    rotate: vi.fn(),
    revokeAllForUser: vi.fn().mockResolvedValue(0),
  };
  const tokens = {
    signAccessToken: vi.fn().mockResolvedValue('access.jwt'),
    issueRefreshToken: vi
      .fn()
      .mockResolvedValue({ token: 'refresh-issued', id: 'rt-issued' }),
    mintRefreshToken: vi.fn().mockReturnValue({
      token: 'refresh-minted',
      tokenHash: TokenService.hash('refresh-minted'),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    }),
  };
  const service = new AuthService(
    users as unknown as UsersRepository,
    refreshTokens as unknown as RefreshTokensRepository,
    tokens as unknown as TokenService,
  );
  return { service, users, refreshTokens, tokens };
};

describe('AuthService', () => {
  describe('register', () => {
    it('stores a bcrypt hash and never returns it', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(undefined);
      users.create.mockImplementation(async (input) => aUser(input));

      const result = await service.register({
        email: 'ana@x.ba',
        password: PASSWORD,
        fullName: 'Ana',
      });

      const stored = users.create.mock.calls[0][0];
      expect(stored.passwordHash).toMatch(/^\$2b\$12\$/);
      expect(await bcrypt.compare(PASSWORD, stored.passwordHash)).toBe(true);
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result).toMatchObject({
        accessToken: 'access.jwt',
        refreshToken: 'refresh-issued',
      });
    });

    it('normalizes the e-mail before lookup and insert', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(undefined);
      users.create.mockImplementation(async (input) => aUser(input));

      await service.register({ email: '  Ana@X.ba ', password: PASSWORD });

      expect(users.findByEmail).toHaveBeenCalledWith('ana@x.ba');
      expect(users.create.mock.calls[0][0].email).toBe('ana@x.ba');
    });

    it('rejects a duplicate e-mail with 409', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(aUser());

      await expect(
        service.register({ email: 'ana@x.ba', password: PASSWORD }),
      ).rejects.toSatisfy((e) => errorOf(e).statusCode === 409);
      expect(users.create).not.toHaveBeenCalled();
    });

    it('never passes a role to the database', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(undefined);
      users.create.mockImplementation(async (input) => aUser(input));

      await service.register({
        email: 'ana@x.ba',
        password: PASSWORD,
        // what a client would try; the DTO strips it before it gets here, and
        // the service must not forward it even if it did not
        ...({ role: 'admin' } as object),
      });

      expect(users.create.mock.calls[0][0]).not.toHaveProperty('role');
    });
  });

  describe('login', () => {
    it('issues tokens for the right password', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(aUser());

      const result = await service.login({
        email: 'ana@x.ba',
        password: PASSWORD,
      });

      expect(result.user.id).toBe('u-1');
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('rejects a wrong password with 401', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(aUser());

      await expect(
        service.login({ email: 'ana@x.ba', password: 'wrong-password-xx' }),
      ).rejects.toSatisfy(
        (e) =>
          errorOf(e).statusCode === 401 &&
          errorOf(e).message === INVALID_CREDENTIALS,
      );
    });

    /**
     * Same status, same message, and the same bcrypt work — otherwise the
     * response (or its timing) tells an attacker which addresses exist.
     */
    it('rejects an unknown user with the identical 401', async () => {
      const { service, users } = setup();
      users.findByEmail.mockResolvedValue(undefined);
      const compare = vi.spyOn(bcrypt, 'compare');

      await expect(
        service.login({ email: 'nobody@x.ba', password: PASSWORD }),
      ).rejects.toSatisfy(
        (e) =>
          errorOf(e).statusCode === 401 &&
          errorOf(e).message === INVALID_CREDENTIALS,
      );
      expect(compare).toHaveBeenCalledTimes(1);
      compare.mockRestore();
    });
  });

  describe('refresh', () => {
    it('rejects an unknown token with 401', async () => {
      const { service, refreshTokens } = setup();
      refreshTokens.findByHash.mockResolvedValue(undefined);

      await expect(service.refresh({ refreshToken: 'nope' })).rejects.toSatisfy(
        (e) => errorOf(e).statusCode === 401,
      );
      expect(refreshTokens.rotate).not.toHaveBeenCalled();
    });

    it('looks the token up by its SHA-256 hash, never by the raw value', async () => {
      const { service, refreshTokens } = setup();
      refreshTokens.findByHash.mockResolvedValue(undefined);

      await service.refresh({ refreshToken: 'old-token' }).catch(() => {});

      expect(refreshTokens.findByHash).toHaveBeenCalledWith(
        TokenService.hash('old-token'),
      );
    });

    it('rejects an expired token with 401', async () => {
      const { service, users, refreshTokens } = setup();
      refreshTokens.findByHash.mockResolvedValue(
        aRefreshToken({ expiresAt: new Date(Date.now() - 1) }),
      );
      users.findById.mockResolvedValue(aUser());

      await expect(
        service.refresh({ refreshToken: 'old-token' }),
      ).rejects.toSatisfy((e) => errorOf(e).statusCode === 401);
      expect(refreshTokens.rotate).not.toHaveBeenCalled();
    });

    it('rotates: spends the old token and returns the minted one', async () => {
      const { service, users, refreshTokens, tokens } = setup();
      const old = aRefreshToken();
      refreshTokens.findByHash.mockResolvedValue(old);
      users.findById.mockResolvedValue(aUser());
      refreshTokens.rotate.mockResolvedValue(aRefreshToken({ id: 'rt-new' }));

      const result = await service.refresh({ refreshToken: 'old-token' });

      const minted = tokens.mintRefreshToken.mock.results[0].value;
      expect(refreshTokens.rotate).toHaveBeenCalledWith(old.id, {
        userId: 'u-1',
        tokenHash: minted.tokenHash,
        expiresAt: minted.expiresAt,
      });
      expect(result.refreshToken).toBe('refresh-minted');
      expect(result.refreshToken).not.toBe('old-token');
      expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    });

    /**
     * The branch ADR 005 exists for: a spent token arriving again means two
     * copies exist, so the whole family goes.
     */
    it('revokes every token of the user when a spent token is presented', async () => {
      const { service, refreshTokens } = setup();
      refreshTokens.findByHash.mockResolvedValue(
        aRefreshToken({ revokedAt: new Date(), replacedBy: 'rt-new' }),
      );
      refreshTokens.revokeAllForUser.mockResolvedValue(3);

      await expect(
        service.refresh({ refreshToken: 'old-token' }),
      ).rejects.toSatisfy((e) => errorOf(e).statusCode === 401);

      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u-1');
      expect(refreshTokens.rotate).not.toHaveBeenCalled();
    });

    /**
     * The race: the token was unspent at `findByHash` but spent by the time
     * `rotate` ran its compare-and-swap. A concurrent request holds a copy —
     * treated exactly like the branch above.
     */
    it('treats a lost compare-and-swap as reuse', async () => {
      const { service, users, refreshTokens } = setup();
      refreshTokens.findByHash.mockResolvedValue(aRefreshToken());
      users.findById.mockResolvedValue(aUser());
      refreshTokens.rotate.mockResolvedValue(undefined);

      await expect(
        service.refresh({ refreshToken: 'old-token' }),
      ).rejects.toSatisfy((e) => errorOf(e).statusCode === 401);

      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u-1');
    });
  });

  describe('getUser', () => {
    it('lets a user read their own account', async () => {
      const { service, users } = setup();
      const me = aUser();
      users.findById.mockResolvedValue(me);

      const result = await service.getUser(asContext(me), me.id);

      expect(result.id).toBe(me.id);
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('lets an admin read anyone', async () => {
      const { service, users } = setup();
      const admin = aUser({ id: 'u-admin', role: 'admin' });
      users.findById.mockResolvedValue(aUser());

      await expect(
        service.getUser(asContext(admin), 'u-1'),
      ).resolves.toMatchObject({ id: 'u-1' });
    });

    it("forbids a reader from reading someone else's account", async () => {
      const { service, users } = setup();
      const reader = aUser({ id: 'u-reader', role: 'reader' });

      await expect(service.getUser(asContext(reader), 'u-1')).rejects.toSatisfy(
        (e) => errorOf(e).statusCode === 403,
      );
      // denied before the read, so the record's existence is not revealed
      expect(users.findById).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing account', async () => {
      const { service, users } = setup();
      const admin = aUser({ id: 'u-admin', role: 'admin' });
      users.findById.mockResolvedValue(undefined);

      await expect(
        service.getUser(asContext(admin), 'u-missing'),
      ).rejects.toSatisfy((e) => errorOf(e).statusCode === 404);
    });
  });

  describe('listUsers', () => {
    it('maps every record without its password hash', async () => {
      const { service, users } = setup();
      users.list.mockResolvedValue([aUser(), aUser({ id: 'u-2' })]);

      const result = await service.listUsers();

      expect(result).toHaveLength(2);
      for (const dto of result) {
        expect(dto).not.toHaveProperty('passwordHash');
      }
    });
  });
});
