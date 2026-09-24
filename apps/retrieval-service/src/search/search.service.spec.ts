import { Logger } from '@nestjs/common';
import type { RpcException } from '@nestjs/microservices';
import type { AuthContext, RpcErrorShape } from '@app/common';
import type { AppConfigService } from '@app/config';
import type { EmbeddingProvider } from '@app/embeddings';
import type { Reranker } from '../rerank/reranker.js';
import type {
  BranchHit,
  SearchHydration,
  SearchRepository,
} from './search.repository.js';
import { SearchService } from './search.service.js';

Logger.overrideLogger(false);

const errorOf = (e: unknown) => (e as RpcException).getError() as RpcErrorShape;

const analyst: AuthContext = {
  userId: 'u-1',
  email: 'analyst@x.ba',
  roles: ['analyst'],
};

const hit = (id: string, score: number): BranchHit => ({
  chunkId: id,
  score,
});

const row = (id: string): SearchHydration => ({
  chunkId: id,
  documentId: 'doc-1',
  documentTitle: 'Master Services Agreement',
  chunkIndex: Number(id.split('-')[1]),
  content: `content of ${id}`,
  pageNumber: 1,
  sectionTitle: null,
});

const config = {
  searchCandidates: 20,
  searchFused: 10,
  searchTopK: 5,
  rrfK: 60,
  hnswEfSearch: 100,
} as AppConfigService;

const setup = ({
  vector = [hit('c-0', 0.9), hit('c-1', 0.8)],
  lexical = [hit('c-1', 0.5), hit('c-2', 0.4)],
  reranker,
}: {
  vector?: BranchHit[];
  lexical?: BranchHit[];
  reranker?: Partial<Reranker>;
} = {}) => {
  const repository = {
    search: vi.fn().mockResolvedValue({ vector, lexical }),
    hydrate: vi
      .fn()
      .mockImplementation((ids: string[]) => Promise.resolve(ids.map(row))),
  } as unknown as SearchRepository;

  const embeddings = {
    name: 'fake',
    model: 'test',
    dimensions: 4,
    embed: vi
      .fn()
      .mockResolvedValue({ vectors: [[1, 0, 0, 0]], totalTokens: 3 }),
  } satisfies EmbeddingProvider as unknown as EmbeddingProvider;

  const rerankerStub = {
    name: 'none',
    model: '',
    rerank: vi.fn(),
    ...reranker,
  } as Reranker;

  return {
    service: new SearchService(repository, config, embeddings, rerankerStub),
    repository,
    embeddings,
    reranker: rerankerStub,
  };
};

describe('SearchService', () => {
  // The model embeds a passage and a question differently; sending
  // `document` for a question is a silent quality loss, not an error.
  it('embeds the question as a query, never as a document', async () => {
    const { service, embeddings } = setup();

    await service.search(analyst, { query: 'notice period', mode: 'hybrid' });

    expect(embeddings.embed).toHaveBeenCalledWith(['notice period'], 'query');
  });

  it('fuses both branches and reports where each result came from', async () => {
    const { service } = setup();

    const results = await service.search(analyst, {
      query: 'notice',
      mode: 'hybrid',
    });

    // c-1 is in both lists, so RRF puts it first even though c-0 leads one.
    expect(results.results.map((r) => r.chunkId)).toEqual([
      'c-1',
      'c-0',
      'c-2',
    ]);
    expect(results.results[0]).toMatchObject({
      vectorRank: 2,
      lexicalRank: 1,
      similarity: 0.8,
    });
    expect(results.results[2]).toMatchObject({
      vectorRank: null,
      lexicalRank: 2,
      similarity: 0,
    });
    expect(results.candidates).toEqual({ vector: 2, lexical: 2, fused: 3 });
  });

  it('runs only the branch the mode asks for', async () => {
    const { service, repository } = setup();

    await service.search(analyst, { query: 'q', mode: 'vector' });
    expect(repository.search).toHaveBeenLastCalledWith(
      expect.anything(),
      'q',
      expect.objectContaining({ vector: true, lexical: false }),
    );

    await service.search(analyst, { query: 'q', mode: 'lexical' });
    expect(repository.search).toHaveBeenLastCalledWith(
      expect.anything(),
      'q',
      expect.objectContaining({ vector: false, lexical: true }),
    );
  });

  it('does not embed anything for a lexical-only search', async () => {
    const { service, embeddings } = setup();

    const results = await service.search(analyst, {
      query: 'q',
      mode: 'lexical',
    });

    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(results.timings.embeddingMs).toBe(0);
    expect(results.timings.vectorMs).toBe(0);
  });

  it('passes the viewer, the candidate count and the ef_search value down', async () => {
    const { service, repository } = setup();

    await service.search(analyst, {
      query: 'q',
      mode: 'hybrid',
      documentId: 'doc-1',
    });

    expect(repository.search).toHaveBeenCalledWith(
      [1, 0, 0, 0],
      'q',
      expect.objectContaining({
        viewer: analyst,
        limit: 20,
        documentId: 'doc-1',
        efSearch: 100,
      }),
    );
  });

  it('returns SEARCH_TOP_K results unless the caller asks for fewer', async () => {
    const { service } = setup();

    expect(
      (await service.search(analyst, { query: 'q', mode: 'hybrid' })).results,
    ).toHaveLength(3);
    expect(
      (await service.search(analyst, { query: 'q', mode: 'hybrid', limit: 1 }))
        .results,
    ).toHaveLength(1);
  });

  it('rejects a question that is only whitespace', async () => {
    const { service, repository } = setup();

    const error = await service
      .search(analyst, { query: '   ', mode: 'hybrid' })
      .then(
        () => null,
        (e: unknown) => errorOf(e),
      );

    expect(error!.statusCode).toBe(400);
    expect(repository.search).not.toHaveBeenCalled();
  });

  it('returns nothing, and reranks nothing, when both branches are empty', async () => {
    const { service, reranker } = setup({ vector: [], lexical: [] });

    const results = await service.search(analyst, {
      query: 'nothing matches this',
      mode: 'hybrid',
    });

    expect(results.results).toEqual([]);
    expect(results.candidates).toEqual({ vector: 0, lexical: 0, fused: 0 });
    expect(reranker.rerank).not.toHaveBeenCalled();
  });

  describe('reranking', () => {
    // A fresh stub per test: one shared `vi.fn()` would carry its calls from
    // one assertion into the next.
    const cohere = () => ({
      name: 'cohere',
      model: 'rerank-v3.5',
      rerank: vi.fn().mockResolvedValue([
        { id: 'c-2', score: 0.95 },
        { id: 'c-1', score: 0.4 },
      ]),
    });

    it('reorders by the reranker and reports it by name', async () => {
      const { service } = setup({ reranker: cohere() });

      const results = await service.search(analyst, {
        query: 'q',
        mode: 'hybrid',
      });

      expect(results.reranker).toBe('cohere');
      expect(results.results.map((r) => r.chunkId)).toEqual(['c-2', 'c-1']);
      expect(results.results[0].score).toBe(0.95);
      expect(results.timings.rerankMs).toBeGreaterThanOrEqual(0);
    });

    it('shows the reranker the fused candidates, with their text', async () => {
      const { service, reranker } = setup({ reranker: cohere() });

      await service.search(analyst, { query: 'notice', mode: 'hybrid' });

      expect(reranker.rerank).toHaveBeenLastCalledWith(
        'notice',
        [
          { id: 'c-1', text: 'content of c-1' },
          { id: 'c-0', text: 'content of c-0' },
          { id: 'c-2', text: 'content of c-2' },
        ],
        5,
      );
    });

    it('skips a configured reranker when the request says so', async () => {
      const { service, reranker } = setup({ reranker: cohere() });

      const results = await service.search(analyst, {
        query: 'q',
        mode: 'hybrid',
        rerank: false,
      });

      expect(reranker.rerank).not.toHaveBeenCalled();
      expect(results.reranker).toBe('none');
      expect(results.timings.rerankMs).toBe(0);
    });

    it('does not invent a reranker when the request asks for one', async () => {
      const { service, reranker } = setup();

      const results = await service.search(analyst, {
        query: 'q',
        mode: 'hybrid',
        rerank: true,
      });

      expect(reranker.rerank).not.toHaveBeenCalled();
      expect(results.reranker).toBe('none');
    });

    // Reranking improves an order that is already useful; losing it must not
    // cost the answer (ADR 015).
    it('keeps the fusion order when the reranker fails', async () => {
      const { service } = setup({
        reranker: {
          name: 'cohere',
          model: 'rerank-v3.5',
          rerank: vi.fn().mockRejectedValue(new Error('Cohere responded 503')),
        },
      });

      const results = await service.search(analyst, {
        query: 'q',
        mode: 'hybrid',
      });

      expect(results.reranker).toBe('none');
      expect(results.results.map((r) => r.chunkId)).toEqual([
        'c-1',
        'c-0',
        'c-2',
      ]);
    });
  });
});
