import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDatabase, refreshTokens } from '@app/database';

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
  createdAt: Date;
}

@Injectable()
export class RefreshTokensRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const [row] = await this.db.insert(refreshTokens).values(input).returning();
    return row;
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    return row;
  }

  /** Marks the token used and, if it was rotated, records its successor. */
  async revoke(id: string, replacedBy?: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedBy: replacedBy ?? null })
      .where(eq(refreshTokens.id, id));
  }

  /**
   * Revokes every active token of a user. Called when reuse of an already-used
   * token is detected — at that point there is no telling who holds which token,
   * so the whole family is torn down and the user must log in again (ADR 005).
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });
    return revoked.length;
  }
}
