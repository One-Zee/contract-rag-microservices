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
 * Segmenti dokumenta — jedinica pretrage u RAG pipelineu.
 *
 * Dimenzija 1024 odgovara modelu `voyage-law-2` i namjerno je literal:
 * ulazi u DDL i u generisanu migraciju, pa se ne smije čitati iz okruženja.
 *
 * Kolona `tsv` (`tsvector GENERATED`) i njen GIN indeks NISU ovdje jer
 * Drizzle nema generisane kolone u šemi — žive u ručnoj migraciji
 * `migrations/0002_chunks_tsv.sql`. Nisu zaboravljene.
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
