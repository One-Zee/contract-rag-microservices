import {
  index,
  integer,
  pgTable,
  text,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { documents } from './documents.js';

/**
 * Document chunks — the unit of retrieval in the RAG pipeline.
 *
 * The dimension 1024 matches the `voyage-law-2` model and is deliberately a
 * literal: it goes into the DDL and the generated migration, so it must not be
 * read from the environment.
 *
 * The `tsv` column (`tsvector GENERATED`) and its GIN index are NOT here
 * because Drizzle has no generated columns in the schema — they live in the
 * hand-written migration `migrations/0002_chunks_tsv.sql`. They are not
 * forgotten.
 */
export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    pageNumber: integer('page_number'),
    sectionTitle: text('section_title'),
    tokenCount: integer('token_count'),
    embedding: vector('embedding', { dimensions: 1024 }),
  },
  (t) => [
    index('chunks_embedding_hnsw').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
    index('chunks_doc_idx').on(t.documentId, t.chunkIndex),
  ],
);
