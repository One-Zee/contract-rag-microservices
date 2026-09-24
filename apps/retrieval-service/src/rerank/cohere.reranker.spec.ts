import { Logger } from '@nestjs/common';
import {
  COHERE_BASE_URL,
  COHERE_MAX_DOCUMENTS,
  CohereReranker,
  type CohereRetryOptions,
} from './cohere.reranker.js';
import { RerankError, type RerankCandidate } from './reranker.js';

Logger.overrideLogger(false);

const API_KEY = 'co-secret-key';
const MODEL = 'rerank-v3.5';

const candidates = (...texts: string[]): RerankCandidate[] =>
  texts.map((text, index) => ({ id: `chunk-${index}`, text }));

const THREE = candidates(
  'Termination requires ninety days notice.',
  'The Fees are payable within thirty days.',
  'Governing law is that of Bosnia and Herzegovina.',
);

const rerankResponse = (
  results: { index: number; relevance_score: number }[],
  searchUnits = 1,
): Response =>
  Response.json({
    id: 'req-1',
    results,
    meta: { billed_units: { search_units: searchUnits } },
  });

const errorResponse = (
  status: number,
  body: unknown = { message: `error ${status}` },
  headers: Record<string, string> = {},
): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const setup = (
  responses: (Response | Error)[],
  retry: Omit<CohereRetryOptions, 'sleep'> = {},
) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    if (response instanceof Error) {
      fetch.mockRejectedValueOnce(response);
    } else {
      fetch.mockResolvedValueOnce(response);
    }
  }
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue();
  const reranker = new CohereReranker({
    apiKey: API_KEY,
    model: MODEL,
    fetch,
    retry: { baseDelayMs: 0, ...retry, sleep },
  });
  return { reranker, fetch, sleep };
};

const bodyOf = (fetch: ReturnType<typeof vi.fn>) =>
  JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string);

describe('CohereReranker', () => {
  it('posts the query, the texts and top_n to the rerank endpoint', async () => {
    const { reranker, fetch } = setup([
      rerankResponse([{ index: 0, relevance_score: 0.9 }]),
    ]);

    await reranker.rerank('notice to terminate', THREE, 1);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${COHERE_BASE_URL}/rerank`);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(bodyOf(fetch)).toEqual({
      model: MODEL,
      query: 'notice to terminate',
      documents: THREE.map((c) => c.text),
      top_n: 1,
    });
  });

  // The response carries positions, not ids: a wrong mapping here would cite
  // the wrong clause while looking perfectly ordered.
  it('maps results back to ids by index and sorts by score', async () => {
    const { reranker } = setup([
      rerankResponse([
        { index: 2, relevance_score: 0.11 },
        { index: 0, relevance_score: 0.97 },
        { index: 1, relevance_score: 0.42 },
      ]),
    ]);

    const ranked = await reranker.rerank('anything', THREE, 3);

    expect(ranked).toEqual([
      { id: 'chunk-0', score: 0.97 },
      { id: 'chunk-1', score: 0.42 },
      { id: 'chunk-2', score: 0.11 },
    ]);
  });

  it('never asks for more than it sent', async () => {
    const { reranker, fetch } = setup([
      rerankResponse([{ index: 0, relevance_score: 0.5 }]),
    ]);

    await reranker.rerank('q', THREE, 50);

    expect(bodyOf(fetch).top_n).toBe(3);
  });

  it('does not call the API for an empty candidate list or a zero limit', async () => {
    const { reranker, fetch } = setup([]);

    await expect(reranker.rerank('q', [], 5)).resolves.toEqual([]);
    await expect(reranker.rerank('q', THREE, 0)).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses more documents than one request accepts', async () => {
    const { reranker, fetch } = setup([]);
    const tooMany = Array.from(
      { length: COHERE_MAX_DOCUMENTS + 1 },
      (_, i) => ({ id: `c-${i}`, text: 'x' }),
    );

    await expect(reranker.rerank('q', tooMany, 5)).rejects.toMatchObject({
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retries a 429 and succeeds on the next attempt', async () => {
    const { reranker, fetch } = setup([
      errorResponse(429),
      rerankResponse([{ index: 0, relevance_score: 0.5 }]),
    ]);

    const ranked = await reranker.rerank('q', THREE, 1);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ranked).toEqual([{ id: 'chunk-0', score: 0.5 }]);
  });

  it('waits as long as Retry-After asks', async () => {
    const { reranker, sleep } = setup([
      errorResponse(429, { message: 'slow down' }, { 'retry-after': '2' }),
      rerankResponse([{ index: 0, relevance_score: 0.5 }]),
    ]);

    await reranker.rerank('q', THREE, 1);

    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('gives up after the configured number of attempts', async () => {
    const { reranker, fetch } = setup(
      [errorResponse(503), errorResponse(503), errorResponse(503)],
      { attempts: 3 },
    );

    await expect(reranker.rerank('q', THREE, 1)).rejects.toMatchObject({
      retryable: true,
      status: 503,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry a bad request or a bad key', async () => {
    for (const status of [400, 401]) {
      const { reranker, fetch } = setup([errorResponse(status)]);

      await expect(reranker.rerank('q', THREE, 1)).rejects.toMatchObject({
        retryable: false,
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('treats a network failure as retryable', async () => {
    const { reranker, fetch } = setup([
      new TypeError('fetch failed'),
      rerankResponse([{ index: 0, relevance_score: 0.5 }]),
    ]);

    await expect(reranker.rerank('q', THREE, 1)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed response instead of citing the wrong chunk', async () => {
    for (const results of [
      [{ index: 9, relevance_score: 0.5 }],
      [{ index: 0, relevance_score: 'high' }],
      [{ relevance_score: 0.5 }],
    ]) {
      const { reranker } = setup([Response.json({ results })]);

      await expect(reranker.rerank('q', THREE, 1)).rejects.toBeInstanceOf(
        RerankError,
      );
    }

    const { reranker } = setup([Response.json({ id: 'req-1' })]);
    await expect(reranker.rerank('q', THREE, 1)).rejects.toBeInstanceOf(
      RerankError,
    );
  });

  // Errors are built from the response, never from the request — the request
  // is the only thing that carries the Authorization header.
  it('never puts the API key in an error message', async () => {
    const rejected = setup([
      errorResponse(401, { message: 'invalid api token' }),
    ]);
    const refused = setup([new TypeError('connect ECONNREFUSED 1.2.3.4:443')], {
      attempts: 1,
    });

    for (const { reranker } of [rejected, refused]) {
      const error = await reranker.rerank('q', THREE, 1).then(
        () => null,
        (e: unknown) => e as RerankError,
      );

      expect(error).toBeInstanceOf(RerankError);
      expect(error!.message).not.toContain(API_KEY);
    }
  });
});
