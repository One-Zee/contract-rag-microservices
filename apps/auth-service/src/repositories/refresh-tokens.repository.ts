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

export interface CreateRefreshTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

@Injectable()
export class RefreshTokensRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
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

  /**
   * Spends `oldId` and issues `next` in its place, atomically.
   *
   * Returns `undefined` when `oldId` was already spent — the compare-and-swap
   * on `revoked_at IS NULL` matched no row. Under READ COMMITTED a concurrent
   * UPDATE blocks on the row lock, re-evaluates the WHERE after the first
   * transaction commits, and sees `revoked_at` set. Two requests carrying the
   * same token can therefore never both succeed (ADR 005).
   */
  async rotate(
    oldId: string,
    next: CreateRefreshTokenInput,
  ): Promise<RefreshTokenRecord | undefined> {
    return this.db.transaction(async (tx) => {
      const spent = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshTokens.id, oldId), isNull(refreshTokens.revokedAt)),
        )
        .returning({ id: refreshTokens.id });

      if (spent.length === 0) {
        return undefined;
      }

      const [created] = await tx.insert(refreshTokens).values(next).returning();

      await tx
        .update(refreshTokens)
        .set({ replacedBy: created.id })
        .where(eq(refreshTokens.id, oldId));

      return created;
    });
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
        and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
      )
      .returning({ id: refreshTokens.id });
    return revoked.length;
  }
}
