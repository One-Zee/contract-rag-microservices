import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import type { User } from './db.js';

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const durationMs = (value: string): number => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
};

export interface AuthContext {
  userId: string;
  email: string;
  roles: string[];
}

export const signAccessToken = (
  user: Pick<User, 'id' | 'email' | 'role'>,
): string =>
  jwt.sign(
    { sub: user.id, email: user.email, roles: [user.role] },
    config.privateKey,
    {
      algorithm: 'RS256',
      expiresIn: Math.floor(durationMs(config.accessTtl) / 1000),
      issuer: config.issuer,
      audience: config.audience,
    },
  );

/** Throws on anything but a valid RS256 token from this issuer for this audience. */
export function verifyAccessToken(token: string): AuthContext {
  const claims = jwt.verify(token, config.publicKey, {
    algorithms: ['RS256'],
    issuer: config.issuer,
    audience: config.audience,
  }) as jwt.JwtPayload & { email: string; roles: string[] };
  return {
    userId: claims.sub as string,
    email: claims.email,
    roles: claims.roles,
  };
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export function mintRefreshToken(): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + durationMs(config.refreshTtl)),
  };
}
