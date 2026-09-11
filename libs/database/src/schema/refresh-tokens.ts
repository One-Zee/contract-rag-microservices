import {
  type AnyPgColumn,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Refresh tokens — the only session state the system stores.
 *
 * **Access tokens are never written to the database.** They are self-contained
 * (RS256 signature) and verified locally; storing them would reintroduce the
 * per-request query this whole architecture avoids (ADR 004).
 *
 * What is stored is a **SHA-256 hash, never the token itself**: whoever reads
 * the database gets nothing usable. SHA-256 rather than bcrypt because the token
 * carries 32 bytes of full entropy — bcrypt protects low-entropy passwords, and
 * here it would add ~100 ms per refresh for nothing (ADR 005).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // `.unique()` already creates the index — refresh looks the token up here.
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set ⇒ the token has been used or revoked. The row is not deleted: it is
    // the only way to recognise reuse of a stolen token.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    // The rotation chain. With `revoked_at` it gives an audit trail: which
    // token replaced which, and when the chain was broken.
    replacedBy: uuid('replaced_by').references(
      (): AnyPgColumn => refreshTokens.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId)],
);
