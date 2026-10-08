import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import type {
  AuthContext,
  QueryStreamEvent,
  SearchResultDto,
  SearchResultsDto,
} from '@app/common';
import type { AppConfigService } from '@app/config';
import {
  LlmError,
  type LlmProvider,
  type LlmStreamChunk,
} from '../llm/llm-provider.js';
import { ABSTENTION_SENTENCE } from '../prompt/system-prompt.js';
import { QueryCancellationRegistry } from './cancellation.registry.js';
import type { QueryRepository } from './query.repository.js';
import { QueryService } from './query.service.js';

Logger.overrideLogger(false);

const analyst: AuthContext = {
  userId: 'u-1',
  email: 'analyst@x.ba',
  roles: ['analyst'],
};

const chunk = (overrides: Partial<SearchResultDto> = {}): SearchResultDto => ({
  chunkId: 'c-1',
  documentId: 'd-1',
  documentTitle: 'Acme MSA',
  chunkIndex: 0,
  content: 'Either party may terminate upon ninety days notice.',
  pageNumber: 4,
  sectionTitle: 'Termination',
  score: 0.9,
  vectorRank: 1,
  lexicalRank: 1,
  similarity: 0.8,
  ...overrides,
});

const searchResults = (
  results: SearchResultDto[] = [chunk()],
): SearchResultsDto => ({
  query: 'How much notice?',
  mode: 'hybrid',
  reranker: 'none',
  results,
  candidates: { vector: results.length, lexical: 0, fused: results.length },
  timings: {
    embeddingMs: 7,
    vectorMs: 3,
    lexicalMs: 2,
    rerankMs: 1,
    totalMs: 13,
  },
});

/** Turns a list of answer fragments into a provider. */
const providerOf = (
  ...chunks: LlmStreamChunk[]
): LlmProvider & { stream: ReturnType<typeof vi.fn> } => {
  const stream = vi.fn(async function* () {
    for (const item of chunks) {
      yield item;
    }
  });
  return { name: 'fake', model: 'fake-legal-assistant', stream } as never;
};

const answering = (text: string) =>
  providerOf(
    { type: 'usage', inputTokens: 100 },
    { type: 'text', text },
    { type: 'usage', outputTokens: 20 },
    { type: 'stop', reason: 'end_turn' },
  );

const config = (overrides: Partial<AppConfigService> = {}): AppConfigService =>
  ({
    queryContextChunks: 5,
    queryMinSimilarity: 0,
    queryContextMaxTokens: 6000,
    queryHistoryPageSize: 20,
    llmMaxTokens: 1024,
    llmTemperature: undefined,
    llmCostInputPerMTok: 1,
    llmCostOutputPerMTok: 5,
    ...overrides,
  }) as AppConfigService;

const setup = (
  options: {
    results?: SearchResultDto[];
    provider?: LlmProvider;
    config?: Partial<AppConfigService>;
    saveAnswer?: ReturnType<typeof vi.fn>;
  } = {},
) => {
  const repository = {
    createQuery: vi.fn().mockResolvedValue('q-1'),
    completeQuery: vi.fn().mockResolvedValue(undefined),
    saveAnswer: options.saveAnswer ?? vi.fn().mockResolvedValue('a-1'),
    listHistory: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const retrieval = {
    send: vi
      .fn()
      .mockReturnValue(of(searchResults(options.results ?? [chunk()]))),
  };
  const llm = options.provider ?? answering('Ninety days. [1]');
  const cancellations = new QueryCancellationRegistry();

  const service = new QueryService(
    repository as unknown as QueryRepository,
    config(options.config),
    cancellations,
    retrieval as never,
    llm,
  );

  return { service, repository, retrieval, llm, cancellations };
};

const drain = async (
  source: AsyncGenerator<QueryStreamEvent>,
): Promise<QueryStreamEvent[]> => {
  const events: QueryStreamEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
};

const doneOf = (events: QueryStreamEvent[]) =>
  events.find((e) => e.type === 'done') as Extract<
    QueryStreamEvent,
    { type: 'done' }
  >;

describe('QueryService.ask', () => {
  it('emits meta, then tokens, then done', async () => {
    const { service } = setup();

    const events = await drain(
      service.ask(analyst, { question: 'How much notice?' }, 'tok'),
    );

    expect(events[0].type).toBe('meta');
    expect(events.at(-1)!.type).toBe('done');
    expect(events.filter((e) => e.type === 'token').length).toBeGreaterThan(0);
    expect(doneOf(events).data.answer).toBe('Ninety days. [1]');
  });

  // Identity is the token's; the corpus is decided by retrieval's SQL. Passing
  // a service identity here would answer a reader out of a private contract.
  it('forwards the caller’s access token to retrieval', async () => {
    const { service, retrieval } = setup();

    await drain(
      service.ask(analyst, { question: 'How much notice?' }, 'tok-abc'),
    );

    expect(retrieval.send).toHaveBeenCalledWith(
      'retrieval.search',
      expect.objectContaining({ accessToken: 'tok-abc' }),
    );
  });

  it('rejects an empty question before anything else happens', async () => {
    const { service, retrieval, repository } = setup();

    const failure = await drain(
      service.ask(analyst, { question: '   \n ' }, 'tok'),
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).not.toBeNull();
    expect(retrieval.send).not.toHaveBeenCalled();
    expect(repository.createQuery).not.toHaveBeenCalled();
  });

  // The query id is the handle for cancelling and the row that a crash
  // mid-generation leaves behind, so it has to exist before the model runs.
  it('writes the queries row before calling the model', async () => {
    const order: string[] = [];
    const llm = providerOf({ type: 'text', text: 'Ninety days. [1]' });
    (llm.stream as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        order.push('llm');
        yield { type: 'text', text: 'Ninety days. [1]' };
      },
    );
    const { service, repository } = setup({ provider: llm });
    repository.createQuery.mockImplementation(async () => {
      order.push('insert');
      return 'q-1';
    });

    const events = await drain(
      service.ask(analyst, { question: 'How much notice?' }, 'tok'),
    );

    expect(order).toEqual(['insert', 'llm']);
    expect(events[0]).toMatchObject({ type: 'meta', data: { queryId: 'q-1' } });
  });

  it('records the retrieval timings it was given, plus its own', async () => {
    const { service, repository } = setup();

    const events = await drain(
      service.ask(analyst, { question: 'How much notice?' }, 'tok'),
    );

    expect(repository.createQuery).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingMs: 7, rerankMs: 1 }),
    );
    const { timings } = doneOf(events).data;
    expect(timings.embeddingMs).toBe(7);
    expect(timings.rerankMs).toBe(1);
    expect(timings.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeGreaterThan(0);
  });

  describe('abstention', () => {
    // The cheap path: an unanswerable question must not cost a model call.
    it('does not call the model when retrieval found nothing', async () => {
      const { service, llm } = setup({ results: [] });

      const events = await drain(
        service.ask(analyst, { question: 'What is the price of tea?' }, 'tok'),
      );

      expect(llm.stream).not.toHaveBeenCalled();
      expect(doneOf(events).data).toMatchObject({
        abstained: true,
        abstainReason: 'no_context',
        status: 'abstained',
      });
      expect(doneOf(events).data.answer).toBe(ABSTENTION_SENTENCE);
    });

    it('does not call the model when nothing clears the threshold', async () => {
      const { service, llm } = setup({
        results: [chunk({ similarity: 0.1 })],
        config: { queryMinSimilarity: 0.5 },
      });

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(llm.stream).not.toHaveBeenCalled();
      expect(doneOf(events).data.abstainReason).toBe('below_threshold');
    });

    it('answers normally when the threshold is disabled, however low the similarity', async () => {
      const { service, llm } = setup({
        results: [chunk({ similarity: 0 })],
        config: { queryMinSimilarity: 0 },
      });

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(llm.stream).toHaveBeenCalled();
      expect(doneOf(events).data.abstained).toBe(false);
    });

    // An answer that grounds nothing in the excerpts is not one this system
    // is willing to claim (§9.3).
    it('counts an answer with no valid citation as an abstention', async () => {
      const { service } = setup({
        provider: answering('I think it is ninety days, roughly.'),
      });

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(doneOf(events).data).toMatchObject({
        abstained: true,
        abstainReason: 'no_citations',
        status: 'abstained',
      });
    });

    it('still records an answer row for an abstention', async () => {
      const { service, repository } = setup({ results: [] });

      await drain(service.ask(analyst, { question: 'Anything?' }, 'tok'));

      expect(repository.saveAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          abstained: true,
          tokensIn: 0,
          tokensOut: 0,
          content: ABSTENTION_SENTENCE,
        }),
      );
    });
  });

  describe('citations', () => {
    it('maps a valid marker back to the chunk it names', async () => {
      const { service, repository } = setup({
        results: [chunk({ chunkId: 'c-a' }), chunk({ chunkId: 'c-b' })],
        provider: answering('Ninety days [2].'),
      });

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(doneOf(events).data.citations).toEqual([
        expect.objectContaining({ marker: 2, chunkId: 'c-b' }),
      ]);
      expect(repository.saveAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          citations: [expect.objectContaining({ chunkId: 'c-b', rank: 2 })],
        }),
      );
    });

    // The guardrail: an answer that looks sourced and is not.
    it('reports a marker that was never in the context and stores no row for it', async () => {
      const { service, repository } = setup({
        results: [chunk()],
        provider: answering('The agreement says so [9].'),
      });

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(doneOf(events).data.invalidCitations).toEqual([9]);
      expect(doneOf(events).data.citations).toEqual([]);
      expect(repository.saveAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          citationsOffered: 1,
          citationsValid: 0,
          citations: [],
        }),
      );
    });
  });

  describe('failure', () => {
    it('ends in an error event once tokens have gone out, and records the row', async () => {
      const provider = providerOf();
      (provider.stream as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          yield { type: 'text', text: 'Ninety ' };
          throw new LlmError('overloaded', { retryable: true, status: 529 });
        },
      );
      const { service, repository } = setup({ provider });

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(events.at(-1)).toMatchObject({
        type: 'error',
        data: { statusCode: 529, queryId: 'q-1' },
      });
      expect(events.some((e) => e.type === 'done')).toBe(false);
      expect(repository.completeQuery).toHaveBeenCalledWith(
        'q-1',
        expect.objectContaining({ status: 'failed' }),
      );
      expect(repository.saveAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Ninety ' }),
      );
    });

    it('records a cancelled generation as abandoned', async () => {
      const provider = providerOf();
      const { service, cancellations } = setup({ provider });
      (provider.stream as ReturnType<typeof vi.fn>).mockImplementation(
        async function* () {
          yield { type: 'text', text: 'Ninety ' };
          // What the gateway does when the client walks away mid-answer.
          cancellations.cancel('q-1');
          throw new LlmError('cancelled', { retryable: false });
        },
      );

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(events.at(-1)!.type).toBe('error');
    });

    // The row is the thesis's data, but the answer is the product.
    it('still returns the answer when the log write fails', async () => {
      const { service } = setup({
        saveAnswer: vi.fn().mockRejectedValue(new Error('unique violation')),
      });

      const events = await drain(
        service.ask(analyst, { question: 'How much notice?' }, 'tok'),
      );

      expect(doneOf(events).data.answerId).toBeNull();
      expect(doneOf(events).data.answer).toBe('Ninety days. [1]');
    });
  });

  it('costs the answer from the configured prices', async () => {
    const { service } = setup({
      config: { llmCostInputPerMTok: 1, llmCostOutputPerMTok: 5 },
    });

    const events = await drain(
      service.ask(analyst, { question: 'How much notice?' }, 'tok'),
    );

    // 100 in at $1/Mtok + 20 out at $5/Mtok
    expect(doneOf(events).data.usage).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      estimatedCost: 0.0002,
    });
  });

  it('narrows to one document and records it', async () => {
    const { service, retrieval, repository } = setup();

    await drain(
      service.ask(
        analyst,
        { question: 'How much notice?', documentId: 'd-9' },
        'tok',
      ),
    );

    expect(retrieval.send).toHaveBeenCalledWith(
      'retrieval.search',
      expect.objectContaining({ documentId: 'd-9' }),
    );
    expect(repository.createQuery).toHaveBeenCalledWith(
      expect.objectContaining({ documentIds: ['d-9'] }),
    );
  });
});

describe('QueryService.history', () => {
  it('caps the page size at the configured maximum', async () => {
    const { service, repository } = setup();

    const page = await service.history(analyst, 1, 500);

    expect(repository.listHistory).toHaveBeenCalledWith('u-1', 1, 20);
    expect(page).toMatchObject({ page: 1, limit: 20, total: 0 });
  });

  // History is personal, not a view of the corpus — admin included.
  it('reads only the caller’s own rows', async () => {
    const { service, repository } = setup();

    await service.history(
      { userId: 'u-admin', email: 'a@x.ba', roles: ['admin'] },
      1,
      10,
    );

    expect(repository.listHistory).toHaveBeenCalledWith('u-admin', 1, 10);
  });
});

describe('QueryService.cancel', () => {
  it('reports whether anything was still running', async () => {
    const { service, cancellations } = setup();

    expect(service.cancel('q-missing')).toBe(false);
    cancellations.register('q-1');
    expect(service.cancel('q-1')).toBe(true);
  });
});
