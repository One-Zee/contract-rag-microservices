// A stand-in for the three paid APIs, for load tests only: Voyage
// embeddings, the Anthropic Messages API (streamed and not) and Cohere rerank,
// speaking their wire formats with fixed, configurable latencies.
//
// The system under test stays unchanged — its HTTP clients, timeouts and
// stream parsing all run — and only the far side of the network is replaced:
// a load test measures the system, not a provider's rate limiter or bill.
// The latencies are calibrated from the real evaluation runs
// (eval/load/calibrate-stub.ts); the defaults below are placeholders.
//
//   node eval/load/stub-apis.ts      (in the load-test compose: stub-apis)
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

const env = (name: string, fallback: number): number =>
  Number(process.env[name] ?? fallback);

const PORT = env('STUB_PORT', 8080);
const EMBED_MS = env('STUB_EMBED_MS', 150);
const EMBED_PER_TEXT_MS = env('STUB_EMBED_PER_TEXT_MS', 2);
const RERANK_MS = env('STUB_RERANK_MS', 200);
const TTFT_MS = env('STUB_LLM_TTFT_MS', 600);
const TOKEN_MS = env('STUB_LLM_TOKEN_MS', 10);
const TOKENS = env('STUB_LLM_TOKENS', 120);
const DIMENSIONS = 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
    : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Feature hashing of the words: deterministic, cheap, and similar texts score higher. */
function vector(text: string): number[] {
  const values = new Float64Array(DIMENSIONS);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue;
    let hash = 2166136261;
    for (let i = 0; i < word.length; i++) {
      hash = Math.imul(hash ^ word.charCodeAt(i), 16777619);
    }
    values[(hash >>> 0) % DIMENSIONS] += (hash & 1) === 0 ? 1 : -1;
  }
  const norm = Math.hypot(...values) || 1;
  return Array.from(values, (value) => value / norm);
}

async function embeddings(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson(req);
  const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
  await sleep(EMBED_MS + EMBED_PER_TEXT_MS * input.length);
  send(res, 200, {
    object: 'list',
    data: input.map((text, index) => ({
      object: 'embedding',
      embedding: vector(text),
      index,
    })),
    model: body.model,
    usage: {
      total_tokens: input.reduce(
        (sum, text) => sum + Math.ceil(text.length / 4),
        0,
      ),
    },
  });
}

/** A grounded answer of TOKENS words that cites the first excerpt. */
const answerWords = (): string[] => {
  const words = ['According', 'to', 'the', 'excerpt', '[1],'];
  while (words.length < TOKENS - 1) {
    words.push('the', 'agreement', 'states', 'this');
  }
  return [...words.slice(0, TOKENS - 1), '[1].'];
};

async function messages(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson(req);
  const prompt = JSON.stringify(body.messages ?? '');
  const inputTokens = Math.ceil(
    ((body.system ?? '').length + prompt.length) / 4,
  );

  if (!body.stream) {
    // Only the judge calls without streaming; enough to dry-run the harness.
    await sleep(TTFT_MS);
    const verdict = {
      claims: [
        {
          text: 'stub claim',
          kind: 'fact',
          markers: [{ n: 1, supports: 'yes' }],
        },
      ],
      declines: 'no',
      correct: 'yes',
      reason: 'stub',
    };
    send(res, 200, {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: JSON.stringify(verdict) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: 40 },
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const event = (type: string, data: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  event('message_start', {
    message: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  await sleep(TTFT_MS);
  const words = answerWords();
  for (const [i, word] of words.entries()) {
    if (closed) return;
    event('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: i === 0 ? word : ` ${word}` },
    });
    await sleep(TOKEN_MS);
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: words.length },
  });
  event('message_stop', {});
  res.end();
}

async function rerank(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson(req);
  const documents: unknown[] = body.documents ?? [];
  await sleep(RERANK_MS);
  const topN = Math.min(body.top_n ?? documents.length, documents.length);
  send(res, 200, {
    results: documents
      .map((_, index) => ({
        index,
        relevance_score: 1 - index / Math.max(documents.length, 1),
      }))
      .slice(0, topN),
    meta: { billed_units: { search_units: 1 } },
  });
}

createServer((req, res) => {
  const handle =
    req.method === 'POST' && req.url?.endsWith('/embeddings')
      ? embeddings
      : req.method === 'POST' && req.url?.endsWith('/messages')
        ? messages
        : req.method === 'POST' && req.url?.endsWith('/rerank')
          ? rerank
          : null;
  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { status: 'ok' });
    return;
  }
  if (!handle) {
    send(res, 404, { error: 'not found' });
    return;
  }
  handle(req, res).catch((error: unknown) => {
    send(res, 500, { error: String(error) });
  });
}).listen(PORT, () => {
  console.log(
    `stub-apis on :${PORT} — embed ${EMBED_MS}+${EMBED_PER_TEXT_MS}/text ms, rerank ${RERANK_MS} ms, ttft ${TTFT_MS} ms, ${TOKENS} tokens × ${TOKEN_MS} ms`,
  );
});
