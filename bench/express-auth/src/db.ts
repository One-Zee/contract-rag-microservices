import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { refreshTokens } from '@app/database/schema/refresh-tokens.js';
import { users } from '@app/database/schema/users.js';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = drizzle(pool);

export type User = typeof users.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
type NewRefreshToken = typeof refreshTokens.$inferInsert;

// The same statements as auth-service's two repositories.

export async function findUserByEmail(
  email: string,
): Promise<User | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  fullName: string | null;
}): Promise<User> {
  const [row] = await db.insert(users).values(input).returning();
  return row;
}

export const listUsers = (): Promise<User[]> =>
  db.select().from(users).orderBy(asc(users.createdAt));

export async function createRefreshToken(
  input: NewRefreshToken,
): Promise<RefreshToken> {
  const [row] = await db.insert(refreshTokens).values(input).returning();
  return row;
}

export async function findRefreshToken(
  tokenHash: string,
): Promise<RefreshToken | undefined> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row;
}

/** Compare-and-swap on `revoked_at IS NULL`; `undefined` when already spent. */
export function rotateRefreshToken(
  oldId: string,
  next: NewRefreshToken,
): Promise<RefreshToken | undefined> {
  return db.transaction(async (tx) => {
    const spent = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, oldId), isNull(refreshTokens.revokedAt)))
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

export async function revokeAllRefreshTokens(userId: string): Promise<number> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    )
    .returning({ id: refreshTokens.id });
  return revoked.length;
}
