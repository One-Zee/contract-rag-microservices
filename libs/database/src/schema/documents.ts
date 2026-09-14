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
    pageCount: integer('page_count'),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('documents_uploaded_by_idx').on(t.uploadedBy),
    index('documents_status_idx').on(t.status),
  ],
);
