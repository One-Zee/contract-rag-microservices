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
