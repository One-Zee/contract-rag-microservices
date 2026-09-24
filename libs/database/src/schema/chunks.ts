import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
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
 * hand-written migrations `migrations/0002_chunks_tsv.sql` and, since the
 * hybrid search was built, `migrations/0005_chunks_tsv_english.sql`, which
 * moved the column from the `simple` configuration to `english` (stemming and
 * stopwords). Whoever queries it must say `english` too. They are not
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
    // Unique so a document that is processed twice (crash recovery, re-run)
    // cannot end up with two chunks at the same position — the pipeline
    // replaces a document's chunks inside one transaction and relies on this.
    uniqueIndex('chunks_doc_idx').on(t.documentId, t.chunkIndex),
  ],
);
