import { EmbeddingError } from './embedding-provider.js';
import {
  VOYAGE_BASE_URL,
  VOYAGE_MAX_TEXTS_PER_REQUEST,
  VoyageEmbeddingProvider,
  type VoyageRetryOptions,
} from './voyage.provider.js';

const DIMENSIONS = 4;
const API_KEY = 'pa-secret-key';

const vector = (seed: number, size = DIMENSIONS): number[] =>
  Array.from({ length: size }, (_, i) => seed + i / 10);

const embeddingsResponse = (
  vectors: number[][],
  { totalTokens = 42, shuffle = false } = {},
): Response => {
  const data = vectors.map((embedding, index) => ({
    object: 'embedding',
    embedding,
    index,
  }));
  if (shuffle) {
    data.reverse();
  }
  return Response.json({
    object: 'list',
    data,
    model: 'voyage-law-2',
    usage: { total_tokens: totalTokens },
  });
};

const errorResponse = (
  status: number,
  body: unknown = { detail: `error ${status}` },
  headers: Record<string, string> = {},
): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const setup = (
  responses: (Response | Error)[],
  retry: Omit<VoyageRetryOptions, 'sleep'> = {},
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
  const provider = new VoyageEmbeddingProvider({
    apiKey: API_KEY,
    model: 'voyage-law-2',
    dimensions: DIMENSIONS,
    fetch,
    retry: { attempts: 5, baseDelayMs: 1_000, sleep, ...retry },
  });
  return { fetch, sleep, provider };
};

const requestBody = (fetch: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((fetch.mock.calls[call][1] as RequestInit).body as string);

const failure = (promise: Promise<unknown>): Promise<EmbeddingError> =>
  promise.then(
    () => {
      throw new Error('expected the call to be rejected');
    },
    (error: EmbeddingError) => error,
  );

describe('VoyageEmbeddingProvider', () => {
  describe('request', () => {
    it('POSTs the texts with the model, the input type and truncation, bearer-authenticated', async () => {
      const { fetch, provider } = setup([
        embeddingsResponse([vector(1), vector(2)]),
      ]);

      await provider.embed(['first', 'second'], 'document');

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${VOYAGE_BASE_URL}/embeddings`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(requestBody(fetch)).toEqual({
        input: ['first', 'second'],
        model: 'voyage-law-2',
        input_type: 'document',
        truncation: true,
      });
    });

    it('sends `query` as the input type for the search side', async () => {
      const { fetch, provider } = setup([embeddingsResponse([vector(1)])]);

      await provider.embed(['notice period?'], 'query');

      expect(requestBody(fetch).input_type).toBe('query');
    });

    it('returns the vectors in input order even when the API lists them shuffled, with the usage', async () => {
      const { provider } = setup([
        embeddingsResponse([vector(1), vector(2), vector(3)], {
          shuffle: true,
          totalTokens: 17,
        }),
      ]);

      const batch = await provider.embed(['a', 'b', 'c'], 'document');

      expect(batch.vectors).toEqual([vector(1), vector(2), vector(3)]);
      expect(batch.totalTokens).toBe(17);
    });

    it('answers an empty batch without calling the API', async () => {
      const { fetch, provider } = setup([]);

      await expect(provider.embed([], 'document')).resolves.toEqual({
        vectors: [],
        totalTokens: 0,
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses more texts than one request may carry, before calling', async () => {
      const { fetch, provider } = setup([]);

      const error = await failure(
        provider.embed(
          Array.from({ length: VOYAGE_MAX_TEXTS_PER_REQUEST + 1 }, () => 'x'),
          'document',
        ),
      );

      expect(error.retryable).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('retries', () => {
    it('retries a 429 with exponential backoff and succeeds', async () => {
      const { fetch, sleep, provider } = setup([
        errorResponse(429),
        errorResponse(429),
        embeddingsResponse([vector(1)]),
      ]);

      const batch = await provider.embed(['x'], 'document');

      expect(batch.vectors).toEqual([vector(1)]);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      const [first, second] = sleep.mock.calls.map(([ms]) => ms);
      expect(first).toBeGreaterThanOrEqual(1_000);
      expect(first).toBeLessThan(1_250);
      expect(second).toBeGreaterThanOrEqual(2_000);
      expect(second).toBeLessThan(2_250);
    });

    it('waits what Retry-After asks for instead of its own backoff', async () => {
      const { sleep, provider } = setup([
        errorResponse(429, { detail: 'slow down' }, { 'retry-after': '7' }),
        embeddingsResponse([vector(1)]),
      ]);

      await provider.embed(['x'], 'document');

      expect(sleep).toHaveBeenCalledWith(7_000);
    });

    it('caps a Retry-After at the maximum delay', async () => {
      const { sleep, provider } = setup(
        [
          errorResponse(429, {}, { 'retry-after': '600' }),
          embeddingsResponse([vector(1)]),
        ],
        { maxDelayMs: 30_000 },
      );

      await provider.embed(['x'], 'document');

      expect(sleep).toHaveBeenCalledWith(30_000);
    });

    it('gives up after the configured attempts with a retryable error', async () => {
      const { fetch, provider } = setup(
        Array.from({ length: 5 }, () => errorResponse(503, 'upstream down')),
      );

      const error = await failure(provider.embed(['x'], 'document'));

      expect(error).toBeInstanceOf(EmbeddingError);
      expect(error.retryable).toBe(true);
      expect(error.status).toBe(503);
      expect(error.message).toContain('503');
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    it('retries a network failure and a timeout, which fetch reports as exceptions', async () => {
      const timeout = new DOMException(
        'The operation was aborted',
        'TimeoutError',
      );
      const { fetch, provider } = setup([
        new TypeError('fetch failed'),
        timeout,
        embeddingsResponse([vector(1)]),
      ]);

      await provider.embed(['x'], 'document');

      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each([400, 401, 403, 404, 422])(
      'does not retry a %i — it would fail the same way again',
      async (status) => {
        const { fetch, sleep, provider } = setup([
          errorResponse(status, { detail: 'nope' }),
          embeddingsResponse([vector(1)]),
        ]);

        const error = await failure(provider.embed(['x'], 'document'));

        expect(error.retryable).toBe(false);
        expect(error.status).toBe(status);
        expect(error.message).toBe(`Voyage responded ${status}: nope`);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      },
    );

    it('never puts the API key into an error message', async () => {
      const { provider } = setup([errorResponse(401, 'Unauthorized', {})]);

      const error = await failure(provider.embed(['x'], 'document'));

      expect(error.message).not.toContain(API_KEY);
    });
  });

  describe('response validation (non-retryable)', () => {
    it('rejects a vector of the wrong dimension', async () => {
      const { provider } = setup([
        embeddingsResponse([vector(1), vector(2, DIMENSIONS + 1)]),
      ]);

      const error = await failure(provider.embed(['a', 'b'], 'document'));

      expect(error.retryable).toBe(false);
      expect(error.message).toContain(`${DIMENSIONS + 1}-dimensional`);
    });

    it('rejects fewer vectors than texts', async () => {
      const { provider } = setup([embeddingsResponse([vector(1)])]);

      const error = await failure(provider.embed(['a', 'b'], 'document'));

      expect(error.retryable).toBe(false);
      expect(error.message).toContain('1 embeddings for 2 texts');
    });

    it('rejects a body without a data list', async () => {
      const { provider } = setup([Response.json({ detail: 'weird' })]);

      const error = await failure(provider.embed(['a'], 'document'));

      expect(error.retryable).toBe(false);
    });

    it('rejects a duplicated index rather than dropping a vector', async () => {
      const { provider } = setup([
        Response.json({
          data: [
            { embedding: vector(1), index: 0 },
            { embedding: vector(2), index: 0 },
          ],
        }),
      ]);

      const error = await failure(provider.embed(['a', 'b'], 'document'));

      expect(error.retryable).toBe(false);
      expect(error.message).toContain('malformed');
    });

    it('reports no usage as null rather than zero', async () => {
      const { provider } = setup([
        Response.json({ data: [{ embedding: vector(1), index: 0 }] }),
      ]);

      const batch = await provider.embed(['a'], 'document');

      expect(batch.totalTokens).toBeNull();
    });
  });
});
