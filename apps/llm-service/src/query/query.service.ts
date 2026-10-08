import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import {
  type Attributes,
  type Span,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import { firstValueFrom } from 'rxjs';
import {
  RETRIEVAL_PATTERNS,
  rpcBadRequest,
  type AbstainReason,
  type AuthContext,
  type PaginatedQueryHistoryDto,
  type QueryCitationDto,
  type QuerySourceDto,
  type QueryStatus,
  type QueryStreamEvent,
  type QueryTimingsDto,
  type SearchMode,
  type SearchResultDto,
  type SearchResultsDto,
  type SearchRpcPayload,
} from '@app/common';
import { AppConfigService } from '@app/config';
import { getTracer, iterateInSpan } from '@app/telemetry';
import { RETRIEVAL_CLIENT } from '../clients/retrieval-client.module.js';
import { LLM, LlmError, type LlmProvider } from '../llm/llm-provider.js';
import { extractMarkers, validateCitations } from '../prompt/citations.js';
import { buildContext, buildPrompt } from '../prompt/context-block.js';
import {
  ABSTENTION_SENTENCE,
  declinesInWords,
  SYSTEM_PROMPT,
} from '../prompt/system-prompt.js';
import { QueryCancellationRegistry } from './cancellation.registry.js';
import { queryInstruments } from './query.metrics.js';
import { QueryRepository } from './query.repository.js';
import { sanitizeQuestion } from './sanitize.js';

export interface AskParams {
  question: string;
  documentId?: string;
  mode?: SearchMode;
  limit?: number;
  rerank?: boolean;
}

/** Everything the two endings — abstain and generate — need from the start. */
interface Pipeline {
  queryId: string;
  question: string;
  /** The rendered CONTEXT block; built once, in `ask`. */
  block: string;
  /** The excerpts it contains: `used[i]` is `[i + 1]`. */
  used: SearchResultDto[];
  startedAt: number;
  retrievalTimings: {
    embeddingMs: number;
    retrievalMs: number;
    rerankMs: number;
  };
}

/** What is known about a model call when it ends, however it ends. */
interface ModelCall {
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
  failure: LlmError | null;
  cancelled: boolean;
}

interface Outcome {
  answerId: string | null;
  answer: string;
  valid: number[];
  invalid: number[];
  abstained: boolean;
  abstainReason: AbstainReason | null;
  status: QueryStatus;
  tokensIn: number;
  tokensOut: number;
  llmMs: number;
}

const elapsed = (since: number): number =>
  Math.round((performance.now() - since) * 100) / 100;

/** Per-million-token prices are configuration; this turns them into a row value. */
const costOf = (
  tokensIn: number,
  tokensOut: number,
  inPerMTok: number,
  outPerMTok: number,
): number => {
  const raw = (tokensIn * inPerMTok + tokensOut * outPerMTok) / 1_000_000;
  return Math.round(raw * 1_000_000) / 1_000_000;
};

@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name);

  constructor(
    private readonly repository: QueryRepository,
    private readonly config: AppConfigService,
    private readonly cancellations: QueryCancellationRegistry,
    @Inject(RETRIEVAL_CLIENT) private readonly retrieval: ClientProxy,
    @Inject(LLM) private readonly llm: LlmProvider,
  ) {}

  /**
   * The answer pipeline, as an async generator.
   *
   * A generator rather than an Observable because the logic is sequential and
   * reads that way; the controller wraps it with `from()`, and Nest's TCP
   * transport turns each `yield` into its own packet. It is also what makes
   * the whole thing testable by iterating it — no rxjs, no Nest.
   *
   * Everything that can legitimately be an HTTP status — a blank question, an
   * expired token, retrieval being unreachable — happens before the first
   * `yield`, so the gateway can still turn it into a real 400/401/503. After
   * the first event the response is committed and a failure can only be an
   * `error` event.
   */
  async *ask(
    auth: AuthContext,
    params: AskParams,
    accessToken: string,
  ): AsyncGenerator<QueryStreamEvent> {
    const startedAt = performance.now();
    const question = sanitizeQuestion(params.question);
    if (question.length === 0) {
      throw rpcBadRequest('A question is required');
    }

    const mode: SearchMode = params.mode ?? 'hybrid';
    const wanted = params.limit ?? this.config.queryContextChunks;

    const retrievalStartedAt = performance.now();
    const found = await this.retrieve(
      accessToken,
      question,
      mode,
      wanted,
      params,
    );
    const retrievalMs = elapsed(retrievalStartedAt);

    // Built once, here: the budget can drop excerpts, and the `[n]` markers
    // must be numbered over what survives — never over `wanted`.
    const context = buildContext(found.results, {
      maxTokens: this.config.queryContextMaxTokens,
    });

    const queryId = await this.repository.createQuery({
      userId: auth.userId,
      question,
      documentIds: params.documentId ? [params.documentId] : [],
      mode,
      contextChunks: context.used.length,
      minSimilarity: this.config.queryMinSimilarity,
      embeddingMs: found.timings.embeddingMs,
      retrievalMs,
      rerankMs: found.timings.rerankMs,
    });

    const pipeline: Pipeline = {
      queryId,
      question,
      block: context.block,
      used: context.used,
      startedAt,
      retrievalTimings: {
        embeddingMs: found.timings.embeddingMs,
        retrievalMs,
        rerankMs: found.timings.rerankMs,
      },
    };

    yield {
      type: 'meta',
      data: {
        queryId,
        question,
        mode,
        model: this.llm.model,
        sources: context.used.map(toSource),
      },
    };

    const reason = this.abstentionBefore(context.used);
    yield* reason ? this.abstain(pipeline, reason) : this.generate(pipeline);
  }

  /** `GET /query/history`, one user's own questions. */
  async history(
    auth: AuthContext,
    page: number,
    limit: number,
  ): Promise<PaginatedQueryHistoryDto> {
    const capped = Math.min(limit, this.config.queryHistoryPageSize);
    const { items, total } = await this.repository.listHistory(
      auth.userId,
      page,
      capped,
    );
    return { items, total, page, limit: capped };
  }

  cancel(queryId: string): boolean {
    return this.cancellations.cancel(queryId);
  }

  /**
   * Retrieval runs with the *caller's* token, not a service identity: the
   * visibility filter lives in retrieval's SQL, so forwarding the token is
   * what keeps a reader from being answered out of someone else's private
   * contract.
   */
  private retrieve(
    accessToken: string,
    question: string,
    mode: SearchMode,
    limit: number,
    params: AskParams,
  ): Promise<SearchResultsDto> {
    return firstValueFrom(
      this.retrieval.send<SearchResultsDto>(RETRIEVAL_PATTERNS.SEARCH, {
        accessToken,
        query: question,
        mode,
        limit,
        documentId: params.documentId,
        rerank: params.rerank,
      } satisfies SearchRpcPayload),
    );
  }

  /**
   * plan"ako nijedan segment ne prelazi prag sličnosti, model mora reći
   * da nema podatak". Decided here, before the model is called, so an
   * unanswerable question costs nothing and always abstains the same way.
   */
  private abstentionBefore(used: SearchResultDto[]): AbstainReason | null {
    if (used.length === 0) {
      return 'no_context';
    }
    const threshold = this.config.queryMinSimilarity;
    if (threshold <= 0) {
      return null;
    }
    const best = Math.max(...used.map((result) => result.similarity));
    return best < threshold ? 'below_threshold' : null;
  }

  private async *abstain(
    pipeline: Pipeline,
    reason: AbstainReason,
  ): AsyncGenerator<QueryStreamEvent> {
    yield { type: 'token', data: { text: ABSTENTION_SENTENCE } };

    yield await this.settle(pipeline, {
      answerId: await this.persist(pipeline, {
        content: ABSTENTION_SENTENCE,
        tokensIn: 0,
        tokensOut: 0,
        abstained: true,
        abstainReason: reason,
        finishReason: 'abstained',
        offered: [],
        valid: [],
      }),
      answer: ABSTENTION_SENTENCE,
      valid: [],
      invalid: [],
      abstained: true,
      abstainReason: reason,
      status: 'abstained',
      tokensIn: 0,
      tokensOut: 0,
      llmMs: 0,
    });
  }

  private async *generate(
    pipeline: Pipeline,
  ): AsyncGenerator<QueryStreamEvent> {
    const signal = this.cancellations.register(pipeline.queryId);
    const llmStartedAt = performance.now();
    const call = this.callAttributes();
    const span = this.startModelCall(call, pipeline);
    let firstToken = true;

    let answer = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let finishReason: string | null = null;
    let failure: LlmError | null = null;

    try {
      // Iterated with the span active, so the provider's request is its child
      // even though this generator yields between fragments.
      const stream = iterateInSpan(
        span,
        this.llm.stream(
          {
            system: SYSTEM_PROMPT,
            prompt: buildPrompt(pipeline.block, pipeline.question),
            maxTokens: this.config.llmMaxTokens,
            temperature: this.config.llmTemperature,
          },
          signal,
        ),
      );

      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'text':
            if (firstToken) {
              firstToken = false;
              span.addEvent('first_token');
              queryInstruments().timeToFirstToken.record(
                (performance.now() - llmStartedAt) / 1000,
                call,
              );
            }
            answer += chunk.text;
            yield { type: 'token', data: { text: chunk.text } };
            break;
          case 'usage':
            tokensIn = chunk.inputTokens ?? tokensIn;
            tokensOut = chunk.outputTokens ?? tokensOut;
            break;
          case 'stop':
            finishReason = chunk.reason;
            break;
        }
      }
    } catch (error) {
      failure =
        error instanceof LlmError
          ? error
          : new LlmError(
              error instanceof Error ? error.message : String(error),
              {
                retryable: false,
              },
            );
    } finally {
      this.cancellations.release(pipeline.queryId);
      // In `finally`: a consumer that stops iterating ends the generator here,
      // and the span must not be left open.
      this.endModelCall(span, call, llmStartedAt, {
        tokensIn,
        tokensOut,
        finishReason,
        failure,
        cancelled: signal.aborted,
      });
    }

    const llmMs = elapsed(llmStartedAt);
    const cancelled = signal.aborted;
    const offered = extractMarkers(answer);
    const { valid, invalid } = validateCitations(offered, pipeline.used.length);

    // The second abstention path, after the model: it declined in the system
    // prompt's words — whatever it went on to cite beside the question — or it
    // answered without grounding any of it in the excerpts it was given. An
    // answer that cites nothing is not one this system is willing to claim
    // (plan §9.3).
    const abstainReason: AbstainReason | null = failure
      ? null
      : declinesInWords(answer)
        ? 'declined'
        : valid.length === 0
          ? 'no_citations'
          : null;
    const abstained = abstainReason !== null;
    const status: QueryStatus = failure
      ? cancelled
        ? 'abandoned'
        : 'failed'
      : abstained
        ? 'abstained'
        : 'answered';

    const answerId = await this.persist(pipeline, {
      content: answer,
      tokensIn,
      tokensOut,
      abstained,
      abstainReason,
      finishReason: failure
        ? cancelled
          ? 'cancelled'
          : 'error'
        : finishReason,
      offered,
      valid,
    });

    if (failure) {
      await this.complete(pipeline, status, llmMs);
      // The text is already on the user's screen, so this cannot become an
      // HTTP status — it is an in-band event and a recorded row.
      this.logger.warn(
        `Query ${pipeline.queryId} ended as ${status}: ${failure.message}`,
      );
      yield {
        type: 'error',
        data: {
          queryId: pipeline.queryId,
          statusCode: failure.status ?? 502,
          message: failure.message,
        },
      };
      return;
    }

    yield await this.settle(pipeline, {
      answerId,
      answer,
      valid,
      invalid,
      abstained,
      abstainReason,
      status,
      tokensIn,
      tokensOut,
      llmMs,
    });
  }

  /** Who answered, in the GenAI conventions' terms — shared by span and metrics. */
  private callAttributes(): Attributes {
    return {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': this.llm.name,
      'gen_ai.request.model': this.llm.model,
    };
  }

  /**
   * A span per model call. Its attributes describe the call and never its
   * content: the prompt quotes the contract (ADR 016).
   */
  private startModelCall(call: Attributes, pipeline: Pipeline): Span {
    const temperature = this.config.llmTemperature;
    return getTracer().startSpan(`chat ${this.llm.model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        ...call,
        'gen_ai.request.max_tokens': this.config.llmMaxTokens,
        ...(temperature === undefined
          ? {}
          : { 'gen_ai.request.temperature': temperature }),
        'clauseiq.query.context_chunks': pipeline.used.length,
      },
    });
  }

  private endModelCall(
    span: Span,
    call: Attributes,
    startedAt: number,
    { tokensIn, tokensOut, finishReason, failure, cancelled }: ModelCall,
  ): void {
    span.setAttributes({
      'gen_ai.usage.input_tokens': tokensIn,
      'gen_ai.usage.output_tokens': tokensOut,
      'gen_ai.response.finish_reasons': [
        finishReason ??
          (cancelled ? 'cancelled' : failure ? 'error' : 'unfinished'),
      ],
    });
    // A cancelled call is the user leaving, not the provider failing.
    if (failure && !cancelled) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: failure.message });
    }
    span.end();

    const instruments = queryInstruments();
    instruments.operationDuration.record(
      (performance.now() - startedAt) / 1000,
      failure
        ? { ...call, 'error.type': cancelled ? 'cancelled' : 'provider_error' }
        : call,
    );
    if (tokensIn > 0) {
      instruments.tokenUsage.record(tokensIn, {
        ...call,
        'gen_ai.token.type': 'input',
      });
    }
    if (tokensOut > 0) {
      instruments.tokenUsage.record(tokensOut, {
        ...call,
        'gen_ai.token.type': 'output',
      });
    }
  }

  /**
   * Completes the `queries` row, then renders the `done` event from the same
   * numbers. Awaited rather than fired off: `done` is the client's signal that
   * the query is finished, and a reader that follows it straight to
   * `/query/history` must not find a row still marked `failed`.
   */
  private async settle(
    pipeline: Pipeline,
    outcome: Outcome,
  ): Promise<QueryStreamEvent> {
    await this.complete(
      pipeline,
      outcome.status,
      outcome.llmMs,
      outcome.abstainReason,
    );

    const timings: QueryTimingsDto = {
      ...pipeline.retrievalTimings,
      llmMs: outcome.llmMs,
      totalMs: elapsed(pipeline.startedAt),
    };

    return {
      type: 'done',
      data: {
        queryId: pipeline.queryId,
        answerId: outcome.answerId,
        answer: outcome.answer,
        citations: outcome.valid.map((marker) =>
          toCitation(pipeline.used[marker - 1], marker),
        ),
        invalidCitations: outcome.invalid,
        abstained: outcome.abstained,
        abstainReason: outcome.abstainReason,
        status: outcome.status,
        model: this.llm.model,
        usage: {
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          estimatedCost: costOf(
            outcome.tokensIn,
            outcome.tokensOut,
            this.config.llmCostInputPerMTok,
            this.config.llmCostOutputPerMTok,
          ),
        },
        timings,
      },
    };
  }

  /**
   * Never lets a persistence failure destroy an answer the user has read: the
   * row is the thesis's data, but the answer is the product. A missing row is
   * logged and reported as `answerId: null`.
   */
  private async persist(
    pipeline: Pipeline,
    input: {
      content: string;
      tokensIn: number;
      tokensOut: number;
      abstained: boolean;
      abstainReason: AbstainReason | null;
      finishReason: string | null;
      offered: number[];
      valid: number[];
    },
  ): Promise<string | null> {
    try {
      return await this.repository.saveAnswer({
        queryId: pipeline.queryId,
        content: input.content,
        provider: this.llm.name,
        model: this.llm.model,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        estimatedCost: costOf(
          input.tokensIn,
          input.tokensOut,
          this.config.llmCostInputPerMTok,
          this.config.llmCostOutputPerMTok,
        ),
        abstained: input.abstained,
        abstainReason: input.abstainReason,
        finishReason: input.finishReason,
        citationsOffered: input.offered.length,
        citationsValid: input.valid.length,
        citations: input.valid.map((marker) => ({
          chunkId: pipeline.used[marker - 1].chunkId,
          rank: marker,
          similarityScore: pipeline.used[marker - 1].similarity,
        })),
      });
    } catch (error) {
      this.logger.error(
        `Could not record the answer for query ${pipeline.queryId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async complete(
    pipeline: Pipeline,
    status: QueryStatus,
    llmMs: number,
    abstainReason: AbstainReason | null = null,
  ): Promise<void> {
    queryInstruments().outcomes.add(1, {
      'clauseiq.query.status': status,
      ...(abstainReason
        ? { 'clauseiq.query.abstain_reason': abstainReason }
        : {}),
    });
    try {
      await this.repository.completeQuery(pipeline.queryId, {
        status,
        llmMs,
        latencyMs: elapsed(pipeline.startedAt),
      });
    } catch (error) {
      this.logger.error(
        `Could not complete query ${pipeline.queryId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

const toSource = (result: SearchResultDto, index: number): QuerySourceDto => ({
  marker: index + 1,
  chunkId: result.chunkId,
  documentId: result.documentId,
  documentTitle: result.documentTitle,
  pageNumber: result.pageNumber,
  sectionTitle: result.sectionTitle,
  similarity: result.similarity,
});

const toCitation = (
  result: SearchResultDto,
  marker: number,
): QueryCitationDto => ({
  marker,
  chunkId: result.chunkId,
  documentId: result.documentId,
  documentTitle: result.documentTitle,
  pageNumber: result.pageNumber,
  sectionTitle: result.sectionTitle,
  similarity: result.similarity,
});
