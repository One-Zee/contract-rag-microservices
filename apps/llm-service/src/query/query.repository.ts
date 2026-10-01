import { Inject, Injectable } from '@nestjs/common';
import { count, desc, eq } from 'drizzle-orm';
import type {
  AbstainReason,
  QueryHistoryItemDto,
  QueryStatus,
} from '@app/common';
import {
  answerCitations,
  answers,
  DRIZZLE,
  queries,
  type DrizzleDatabase,
} from '@app/database';

export interface NewQuery {
  userId: string;
  question: string;
  documentIds: string[];
  mode: string;
  contextChunks: number;
  minSimilarity: number;
  embeddingMs: number;
  retrievalMs: number;
  rerankMs: number;
}

export interface QueryOutcome {
  status: QueryStatus;
  llmMs: number;
  latencyMs: number;
}

export interface NewAnswer {
  queryId: string;
  content: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  estimatedCost: number;
  abstained: boolean;
  abstainReason: AbstainReason | null;
  finishReason: string | null;
  citationsOffered: number;
  citationsValid: number;
  citations: {
    chunkId: string;
    rank: number;
    similarityScore: number | null;
  }[];
}

/**
 * The query log — plan §6 and the sentence beside it: "Loguj od prvog dana".
 * These three tables are what chapter 4 of the thesis is written from, so the
 * writes here are the deliverable, not bookkeeping.
 *
 * Repositories stay in the owning service (the rule `libs/database` states for
 * the hybrid-search SQL): nothing else reads or writes these tables.
 */
@Injectable()
export class QueryRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Written *before* the model is called. The id is what the client gets in
   * its `meta` event and what a cancel names, and a process that dies
   * mid-generation still has to leave a row behind — a question that produced
   * no answer is a data point for §9.3, not an absence.
   *
   * `status` defaults to `failed` in the schema, so a row that is never
   * completed reads as what it is.
   */
  async createQuery(query: NewQuery): Promise<string> {
    const [row] = await this.db
      .insert(queries)
      .values({
        userId: query.userId,
        question: query.question,
        documentIds: query.documentIds,
        mode: query.mode,
        contextChunks: query.contextChunks,
        minSimilarity: query.minSimilarity,
        embeddingMs: Math.round(query.embeddingMs),
        retrievalMs: Math.round(query.retrievalMs),
        rerankMs: Math.round(query.rerankMs),
      })
      .returning({ id: queries.id });

    return row.id;
  }

  async completeQuery(queryId: string, outcome: QueryOutcome): Promise<void> {
    await this.db
      .update(queries)
      .set({
        status: outcome.status,
        llmMs: Math.round(outcome.llmMs),
        latencyMs: Math.round(outcome.latencyMs),
      })
      .where(eq(queries.id, queryId));
  }

  /**
   * The answer and its citations in one transaction: a citation row without
   * its answer, or an answer whose citation count disagrees with the rows,
   * would each be a silently wrong number in §9.3.
   *
   * An abstention is written here too, with the fallback sentence as
   * `content` — which is what makes the abstention rate one `AVG` rather than
   * a join against rows that do not exist.
   */
  async saveAnswer(answer: NewAnswer): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(answers)
        .values({
          queryId: answer.queryId,
          content: answer.content,
          provider: answer.provider,
          model: answer.model,
          tokensIn: answer.tokensIn,
          tokensOut: answer.tokensOut,
          estimatedCost: answer.estimatedCost,
          abstained: answer.abstained,
          abstainReason: answer.abstainReason,
          finishReason: answer.finishReason,
          citationsOffered: answer.citationsOffered,
          citationsValid: answer.citationsValid,
        })
        .returning({ id: answers.id });

      if (answer.citations.length > 0) {
        await tx.insert(answerCitations).values(
          answer.citations.map((citation) => ({
            answerId: row.id,
            chunkId: citation.chunkId,
            rank: citation.rank,
            similarityScore: citation.similarityScore,
          })),
        );
      }

      return row.id;
    });
  }

  /**
   * One user's questions, newest first — `GET /query/history`.
   *
   * Filtered by `userId` for every role, admin included: history is personal,
   * not a view of the corpus. An admin who needs to audit has the database.
   */
  async listHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ items: QueryHistoryItemDto[]; total: number }> {
    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(queries)
      .where(eq(queries.userId, userId));

    if (total === 0) {
      return { items: [], total: 0 };
    }

    const rows = await this.db
      .select({
        queryId: queries.id,
        question: queries.question,
        status: queries.status,
        latencyMs: queries.latencyMs,
        createdAt: queries.createdAt,
        answer: answers.content,
        abstained: answers.abstained,
        abstainReason: answers.abstainReason,
        model: answers.model,
        citationCount: answers.citationsValid,
      })
      .from(queries)
      // Left: a query that died before its answer was written still belongs in
      // the history, and showing it is the honest thing.
      .leftJoin(answers, eq(answers.queryId, queries.id))
      .where(eq(queries.userId, userId))
      .orderBy(desc(queries.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return {
      items: rows.map((row) => ({
        queryId: row.queryId,
        question: row.question,
        answer: row.answer,
        status: row.status,
        abstained: row.abstained ?? false,
        abstainReason: row.abstainReason,
        citationCount: row.citationCount ?? 0,
        model: row.model,
        latencyMs: row.latencyMs ?? 0,
        createdAt: row.createdAt,
      })),
      total,
    };
  }
}
