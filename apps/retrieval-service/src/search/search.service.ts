import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '@app/config';
import {
  type AuthContext,
  rpcBadRequest,
  type SearchMode,
  type SearchResultDto,
  type SearchResultsDto,
} from '@app/common';
import { EMBEDDINGS, type EmbeddingProvider } from '@app/embeddings';
import { withSpan } from '@app/telemetry';
import {
  RERANKER,
  type RerankCandidate,
  type Reranker,
} from '../rerank/reranker.js';
import { fuse, type RankedId } from './rrf.js';
import { SearchRepository } from './search.repository.js';

export interface SearchParams {
  query: string;
  mode: SearchMode;
  limit?: number;
  documentId?: string;
  rerank?: boolean;
}

/** Index of each branch in the list handed to `fuse`, and so in `ranks`. */
const VECTOR = 0;
const LEXICAL = 1;

const elapsed = (since: number): number =>
  Math.round((performance.now() - since) * 100) / 100;

const ranked = (hits: { chunkId: string }[]): RankedId[] =>
  hits.map((hit, index) => ({ id: hit.chunkId, rank: index + 1 }));

/**
 * The query half of the RAG pipeline (plan §8.2): embed the question, search
 * twice, fuse the rankings, rerank, and return chunks with enough context to
 * cite them.
 *
 * Identity comes from the verified token — `auth`, never a field in the
 * payload — and is used before ranking, in SQL.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly repository: SearchRepository,
    private readonly config: AppConfigService,
    @Inject(EMBEDDINGS) private readonly embeddings: EmbeddingProvider,
    @Inject(RERANKER) private readonly reranker: Reranker,
  ) {}

  async search(
    auth: AuthContext,
    params: SearchParams,
  ): Promise<SearchResultsDto> {
    const query = params.query.trim();
    if (query.length === 0) {
      throw rpcBadRequest('A search needs a question');
    }

    const startedAt = performance.now();
    const limit = Math.min(
      params.limit ?? this.config.searchTopK,
      this.config.searchFused,
    );
    const wantsVector = params.mode !== 'lexical';
    const wantsLexical = params.mode !== 'vector';

    // The question is embedded as a `query`, not as a `document`: the model
    // uses a different internal prompt for each side, and mixing them costs
    // retrieval quality silently (ADR 012).
    const embeddingStartedAt = performance.now();
    const embedding = wantsVector
      ? await withSpan(
          'search.embed',
          {
            'clauseiq.embedding.provider': this.embeddings.name,
            'clauseiq.embedding.model': this.embeddings.model,
          },
          async () =>
            (await this.embeddings.embed([query], 'query')).vectors[0],
        )
      : [];
    const embeddingMs = wantsVector ? elapsed(embeddingStartedAt) : 0;

    const searchStartedAt = performance.now();
    const branches = await this.repository.search(embedding, query, {
      viewer: auth,
      limit: this.config.searchCandidates,
      documentId: params.documentId,
      efSearch: this.config.hnswEfSearch,
      lexicalMatch: this.config.lexicalMatch,
      vector: wantsVector,
      lexical: wantsLexical,
    });
    // One transaction runs both branches, so the split between them is an
    // estimate; the total is exact, which is what §9.4 compares.
    const searchMs = elapsed(searchStartedAt);
    const branchCount = (wantsVector ? 1 : 0) + (wantsLexical ? 1 : 0);
    const perBranchMs = branchCount === 0 ? 0 : searchMs / branchCount;

    const fused = fuse(
      [ranked(branches.vector), ranked(branches.lexical)],
      this.config.rrfK,
    ).slice(0, this.config.searchFused);

    const rows = await this.repository.hydrate(fused.map((f) => f.id));
    const byId = new Map(rows.map((row) => [row.chunkId, row]));
    const similarityById = new Map(
      branches.vector.map((hit) => [hit.chunkId, hit.score]),
    );

    const rerankStartedAt = performance.now();
    const order = await this.order(query, fused, byId, limit, params.rerank);
    const rerankMs = order.reranker === 'none' ? 0 : elapsed(rerankStartedAt);

    const fusedById = new Map(fused.map((f) => [f.id, f]));
    const results: SearchResultDto[] = [];
    for (const { id, score } of order.ranking) {
      const row = byId.get(id);
      // A chunk deleted between the search and the hydration; the citation
      // would point at nothing.
      if (!row) {
        continue;
      }
      const ranks = fusedById.get(id)?.ranks ?? [null, null];
      results.push({
        ...row,
        score,
        vectorRank: ranks[VECTOR],
        lexicalRank: ranks[LEXICAL],
        similarity: similarityById.get(id) ?? 0,
      });
    }

    return {
      query,
      mode: params.mode,
      reranker: order.reranker,
      results,
      candidates: {
        vector: branches.vector.length,
        lexical: branches.lexical.length,
        fused: fused.length,
      },
      timings: {
        embeddingMs,
        vectorMs: wantsVector ? Math.round(perBranchMs * 100) / 100 : 0,
        lexicalMs: wantsLexical ? Math.round(perBranchMs * 100) / 100 : 0,
        rerankMs,
        totalMs: elapsed(startedAt),
      },
    };
  }

  /**
   * Reranking is an improvement, not a condition: if the provider is off, has
   * nothing to look at, or fails, the RRF order stands and the caller still
   * gets an answer (ADR 015). Only the reported `reranker` name changes.
   */
  private async order(
    query: string,
    fused: { id: string; score: number }[],
    byId: Map<string, { content: string }>,
    limit: number,
    requested: boolean | undefined,
  ): Promise<{
    ranking: { id: string; score: number }[];
    reranker: string;
  }> {
    const fallback = {
      ranking: fused.slice(0, limit),
      reranker: 'none',
    };
    const enabled = requested ?? this.reranker.name !== 'none';
    if (!enabled || this.reranker.name === 'none' || fused.length === 0) {
      return fallback;
    }

    const candidates: RerankCandidate[] = [];
    for (const { id } of fused) {
      const row = byId.get(id);
      if (row) {
        candidates.push({ id, text: row.content });
      }
    }

    try {
      const ranking = await withSpan(
        'search.rerank',
        {
          'clauseiq.rerank.provider': this.reranker.name,
          'clauseiq.rerank.candidates': candidates.length,
        },
        () => this.reranker.rerank(query, candidates, limit),
      );
      return { ranking, reranker: this.reranker.name };
    } catch (error) {
      this.logger.warn(
        `Reranking failed, keeping the fusion order: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return fallback;
    }
  }
}
