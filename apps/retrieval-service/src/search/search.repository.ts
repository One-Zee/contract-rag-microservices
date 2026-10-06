import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AuthContext } from '@app/common';
import {
  chunks,
  documentVisibilityCondition,
  documents,
  DRIZZLE,
  type DrizzleDatabase,
} from '@app/database';
import type { LexicalMatch } from '@app/config';
import { withSpan } from '@app/telemetry';

/** The text search configuration migration 0005 sealed into the `tsv` column. */
export const TEXT_SEARCH_CONFIG = 'english';

/**
 * `chunks.tsv` is a generated column, which Drizzle cannot declare, so it is
 * not in the schema object — it exists only in migrations 0002 and 0005. This
 * is the one place that references it, by name.
 */
const TSV = sql`${chunks}."tsv"`;

export interface SearchBranchOptions {
  viewer: AuthContext;
  limit: number;
  documentId?: string;
  /** Visits this many index candidates before the filter — `HNSW_EF_SEARCH`. */
  efSearch: number;
  /** `LEXICAL_MATCH`; `all` when absent. */
  lexicalMatch?: LexicalMatch;
}

/** A hit from one branch: the id, its position, and the branch's own score. */
export interface BranchHit {
  chunkId: string;
  score: number;
}

export interface SearchHydration {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
  sectionTitle: string | null;
}

@Injectable()
export class SearchRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * What the search is allowed to look at, in both branches.
   *
   * Three conditions, and each one is load-bearing:
   *  - visibility, applied here rather than to the results, so a reader gets
   *    `k` chunks they may see instead of whatever survives a later filter
   *  - `embedding IS NOT NULL`, so the two branches draw from one population —
   *    fusing ranks from different corpora would compare positions that mean
   *    different things. A document still being indexed is simply not
   *    searchable yet, which is what its status says;
   *  - the optional single-document scope, which narrows but never widens.
   */
  private corpus(
    viewer: AuthContext,
    documentId: string | undefined,
  ): SQL | undefined {
    return and(
      documentVisibilityCondition(viewer),
      isNotNull(chunks.embedding),
      documentId ? eq(chunks.documentId, documentId) : undefined,
    );
  }

  /**
   * Both branches in one transaction, because the HNSW settings below are
   * `SET LOCAL` — they exist for the length of a transaction and nowhere else,
   * which matters on a pooled connection that the next request will reuse.
   *
   * `set_config(..., true)` rather than `SET LOCAL`: `SET` takes no bind
   * parameters, so the value would have to be interpolated into the statement.
   */
  async search(
    embedding: number[],
    query: string,
    options: SearchBranchOptions & { vector: boolean; lexical: boolean },
  ): Promise<{ vector: BranchHit[]; lexical: BranchHit[] }> {
    return this.db.transaction(async (tx) => {
      if (options.vector) {
        await tx.execute(
          sql`SELECT set_config('hnsw.ef_search', ${String(options.efSearch)}, true)`,
        );
        // pgvector ≥ 0.8: keep scanning when the visibility filter rejects the
        // first candidates, instead of returning fewer rows than asked for
        // (plan §8.2). `relaxed_order` lets it stop at the limit rather than
        // walking the whole index for a perfect ordering.
        await tx.execute(
          sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
        );
      }

      // Ordered by the distance operator itself, ascending — that is the
      // expression the HNSW index answers. `ORDER BY 1 - (…) DESC` returns the
      // same rows in the same order, but the planner no longer recognises it
      // and falls back to a sequential scan over every chunk.
      const distance = cosineDistance(chunks.embedding, embedding);
      const similarity = sql<number>`1 - (${cosineDistance(chunks.embedding, embedding)})`;

      // Named spans around each branch: in a trace the two SELECTs would
      // otherwise be indistinguishable, and their real split is exactly what
      // `timings` can only estimate.
      const vector = options.vector
        ? await withSpan(
            'search.vector',
            {
              'clauseiq.search.limit': options.limit,
              'clauseiq.search.ef_search': options.efSearch,
            },
            async (span) => {
              const hits = await tx
                .select({ chunkId: chunks.id, score: similarity })
                .from(chunks)
                .innerJoin(documents, eq(documents.id, chunks.documentId))
                .where(this.corpus(options.viewer, options.documentId))
                .orderBy(asc(distance))
                .limit(options.limit);
              span.setAttribute('clauseiq.search.hits', hits.length);
              return hits;
            },
          )
        : [];

      // `plainto_tsquery` takes the question as plain text and needs no
      // escaping, unlike `to_tsquery`. The configuration must be the one the
      // generated column used, or this matches nothing.
      //
      // It ANDs the lexemes, so `all` only matches a chunk holding every word
      // of the question — which a question in natural language almost never
      // is. `any` turns the ANDs into ORs in the parsed query (lexemes cannot
      // contain `&`) and ranks by term frequency.
      const parsed = sql`plainto_tsquery(${TEXT_SEARCH_CONFIG}, ${query})`;
      const any = options.lexicalMatch === 'any';
      const tsQuery = any
        ? sql`replace(${parsed}::text, '&', '|')::tsquery`
        : parsed;
      const rank = any
        ? sql<number>`ts_rank(${TSV}, ${tsQuery})`
        : sql<number>`ts_rank_cd(${TSV}, ${tsQuery})`;

      const lexical = options.lexical
        ? await withSpan(
            'search.lexical',
            { 'clauseiq.search.limit': options.limit },
            async (span) => {
              const hits = await tx
                .select({ chunkId: chunks.id, score: rank })
                .from(chunks)
                .innerJoin(documents, eq(documents.id, chunks.documentId))
                .where(
                  and(
                    this.corpus(options.viewer, options.documentId),
                    sql`${TSV} @@ ${tsQuery}`,
                  ),
                )
                .orderBy(desc(rank))
                .limit(options.limit);
              span.setAttribute('clauseiq.search.hits', hits.length);
              return hits;
            },
          )
        : [];

      return { vector, lexical };
    });
  }

  /** The columns a citation needs, for the handful of chunks that survived. */
  async hydrate(chunkIds: string[]): Promise<SearchHydration[]> {
    if (chunkIds.length === 0) {
      return [];
    }
    return this.db
      .select({
        chunkId: chunks.id,
        documentId: chunks.documentId,
        documentTitle: documents.title,
        chunkIndex: chunks.chunkIndex,
        content: chunks.content,
        pageNumber: chunks.pageNumber,
        sectionTitle: chunks.sectionTitle,
      })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(inArray(chunks.id, chunkIds))
      .orderBy(asc(chunks.documentId), asc(chunks.chunkIndex));
  }
}
