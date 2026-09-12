import { randomBytes, createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '@app/config';
import type { UserRoleName } from '@app/common';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository.js';
import type { UserRecord } from './repositories/users.repository.js';

/** Milliseconds per unit in the `15m` / `7d` notation; the Joi schema guarantees the format. */
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export const parseDuration = (value: string): number => {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
};

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
    private readonly refreshTokens: RefreshTokensRepository,
  ) {}

  signAccessToken(
    user: Pick<UserRecord, 'id' | 'email' | 'role'>,
  ): Promise<string> {
    return this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      roles: [user.role] satisfies UserRoleName[],
    });
  }

  async issueRefreshToken(
    userId: string,
  ): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('base64url');
    const record = await this.refreshTokens.create({
      userId,
      tokenHash: TokenService.hash(token),
      expiresAt: new Date(
        Date.now() + parseDuration(this.config.refreshExpiresIn),
      ),
    });
    // The caller needs `id` to set `replaced_by` and keep the rotation chain.
    return { token, id: record.id };
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
