/**
 * Shared by the e2e suites. They boot real services in-process, so each suite
 * generates its own RS256 pair and picks its own ports — nothing here reads
 * anyone's `.env` except the infrastructure URLs the suites take from it.
 */
import { generateKeyPairSync } from 'node:crypto';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';

export const ISSUER = 'clauseiq-auth';
export const AUDIENCE = 'clauseiq-api';
export const PASSWORD = 'correct-horse-battery-staple';

export const rsaPair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

/** Away from the 300x range, so a dev stack running alongside does not collide. */
export const randomPort = () => 30_000 + Math.floor(Math.random() * 10_000);

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const signWith = (
  privateKey: string,
  options: { audience?: string; expiresIn?: JwtSignOptions['expiresIn'] } = {},
) =>
  new JwtService({
    privateKey,
    signOptions: {
      algorithm: 'RS256',
      expiresIn: options.expiresIn ?? '15m',
      issuer: ISSUER,
      audience: options.audience ?? AUDIENCE,
    },
  });

/**
 * Puts the JWT material and the auth-service transport into the environment.
 * `AppConfigModule.forRoot()` validates when a module file is imported, so
 * this must run before the suite's dynamic imports — call it at module level.
 */
export const configureAuthEnv = () => {
  const keys = rsaPair();
  const authPort = randomPort();
  process.env.JWT_PRIVATE_KEY = Buffer.from(keys.privateKey).toString('base64');
  process.env.JWT_PUBLIC_KEY = Buffer.from(keys.publicKey).toString('base64');
  process.env.JWT_ISSUER = ISSUER;
  process.env.JWT_AUDIENCE = AUDIENCE;
  process.env.JWT_EXPIRES_IN = '15m';
  process.env.AUTH_HOST = '127.0.0.1';
  process.env.AUTH_PORT = String(authPort);
  return { keys, authPort };
};
