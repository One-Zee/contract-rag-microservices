import { generateKeyPairSync } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { AUTH_CONTEXT, type AuthContext } from './auth-context.js';
import { RpcAuthGuard } from './rpc-auth.guard.js';

const ISSUER = 'clauseiq-auth';
const AUDIENCE = 'clauseiq-api';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
// A second key pair — used to prove a foreign signature does not pass.
const foreignKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const signer = (privateKey: string) =>
  new JwtService({
    privateKey,
    signOptions: {
      algorithm: 'RS256',
      expiresIn: '15m',
      issuer: ISSUER,
      audience: AUDIENCE,
    },
  });

const verifier = new JwtService({
  publicKey: keys.publicKey,
  verifyOptions: {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  },
});

const rpcContext = (payload: unknown): ExecutionContext =>
  ({
    getType: () => 'rpc',
    switchToRpc: () => ({ getData: () => payload }),
  }) as unknown as ExecutionContext;

const statusOf = (error: unknown) =>
  (error as RpcException).getError() as { statusCode: number };

describe('RpcAuthGuard', () => {
  const guard = new RpcAuthGuard(verifier);
  const token = signer(keys.privateKey).sign({
    sub: 'u-1',
    email: 'a@b.ba',
    roles: ['analyst'],
  });

  it('accepts a valid token and attaches the context from the claims', async () => {
    const payload: Record<PropertyKey, unknown> = { accessToken: token };

    await expect(guard.canActivate(rpcContext(payload))).resolves.toBe(true);

    expect(payload[AUTH_CONTEXT]).toEqual({
      userId: 'u-1',
      email: 'a@b.ba',
      roles: ['analyst'],
    } satisfies AuthContext);
  });

  it('rejects a call with no token', async () => {
    await expect(guard.canActivate(rpcContext({}))).rejects.toThrow(
      RpcException,
    );
  });

  it('rejects a token signed with a different key', async () => {
    const forged = signer(foreignKeys.privateKey).sign({
      sub: 'u-1',
      email: 'a@b.ba',
      roles: ['admin'],
    });

    await expect(
      guard.canActivate(rpcContext({ accessToken: forged })),
    ).rejects.toSatisfy((e: unknown) => statusOf(e).statusCode === 401);
  });

  it('rejects a token with the wrong aud', async () => {
    const wrongAudience = new JwtService({
      privateKey: keys.privateKey,
      signOptions: {
        algorithm: 'RS256',
        expiresIn: '15m',
        issuer: ISSUER,
        audience: 'someone-else',
      },
    }).sign({ sub: 'u-1', email: 'a@b.ba', roles: ['reader'] });

    await expect(
      guard.canActivate(rpcContext({ accessToken: wrongAudience })),
    ).rejects.toThrow(RpcException);
  });

  it('rejects an expired token', async () => {
    const expired = new JwtService({
      privateKey: keys.privateKey,
      signOptions: {
        algorithm: 'RS256',
        expiresIn: '-1s',
        issuer: ISSUER,
        audience: AUDIENCE,
      },
    }).sign({ sub: 'u-1', email: 'a@b.ba', roles: ['reader'] });

    await expect(
      guard.canActivate(rpcContext({ accessToken: expired })),
    ).rejects.toThrow(RpcException);
  });

  /**
   * The reason AUTH_CONTEXT is a symbol and not a string.
   *
   * A client can put any **string**-named field into the JSON payload. If the
   * context key were a string, this would be a path to privilege escalation on
   * any handler left without a guard. A symbol cannot come out of JSON
   * deserialization, so the injected value is simply overwritten.
   */
  it('a payload cannot inject a context', async () => {
    const payload: Record<PropertyKey, unknown> = {
      accessToken: token,
      // how an attacker would try it, were the key a string:
      __auth: { userId: 'attacker', email: 'x@x.ba', roles: ['admin'] },
      [AUTH_CONTEXT]: { userId: 'attacker', email: 'x@x.ba', roles: ['admin'] },
    };

    await guard.canActivate(rpcContext(payload));

    expect(payload[AUTH_CONTEXT]).toEqual({
      userId: 'u-1',
      email: 'a@b.ba',
      roles: ['analyst'],
    });
  });
});
