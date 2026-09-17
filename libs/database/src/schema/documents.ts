import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const documentStatus = pgEnum('document_status', [
  'uploaded',
  'parsing',
  'chunked',
  'indexing',
  'indexed',
  'failed',
]);

export const documentVisibility = pgEnum('document_visibility', [
  'private',
  'shared',
]);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    originalFilename: text('original_filename').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSize: integer('file_size').notNull(),
    status: documentStatus('status').notNull().default('uploaded'),
    visibility: documentVisibility('visibility').notNull().default('private'),
    pageCount: integer('page_count'),
    errorMessage: text('error_message'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('documents_uploaded_by_idx').on(t.uploadedBy),
    index('documents_status_idx').on(t.status),
    index('documents_visibility_idx').on(t.visibility),
  ],
);
