import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readSse } from './sse.ts';

/**
 * The gateway, exactly as a client sees it: every number the harness reports
 * comes through the same HTTP API a user would call.
 */

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
  score: number;
  vectorRank: number | null;
  lexicalRank: number | null;
  similarity: number;
}

export interface SearchResponse {
  mode: string;
  reranker: string;
  results: SearchHit[];
  candidates: { vector: number; lexical: number; fused: number };
  timings: {
    embeddingMs: number;
    vectorMs: number;
    lexicalMs: number;
    rerankMs: number;
    totalMs: number;
  };
}

export interface QuerySource {
  marker: number;
  chunkId: string;
  documentId: string;
  similarity: number;
}

export interface QueryDone {
  queryId: string;
  answerId: string | null;
  answer: string;
  citations: QuerySource[];
  invalidCitations: number[];
  abstained: boolean;
  abstainReason: string | null;
  status: string;
  model: string;
  usage: { tokensIn: number; tokensOut: number; estimatedCost: number };
  timings: {
    embeddingMs: number;
    retrievalMs: number;
    rerankMs: number;
    llmMs: number;
    totalMs: number;
  };
}

export interface QueryResult {
  sources: QuerySource[];
  done: QueryDone | null;
  error: { statusCode: number; message: string } | null;
  /** Client-side: request sent → first `token` event (null if none came). */
  ttftMs: number | null;
  /** Client-side: request sent → stream closed. */
  totalMs: number;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

export class Gateway {
  readonly base: string;
  token: string | null = null;

  constructor(base: string) {
    this.base = base;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token
      ? { ...extra, authorization: `Bearer ${this.token}` }
      : extra;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: this.headers((init.headers as Record<string, string>) ?? {}),
      signal: init.signal ?? AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(response.status, text);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  register(email: string, password: string): Promise<{ accessToken: string }> {
    return this.json('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        fullName: 'ClauseIQ evaluation',
      }),
    });
  }

  async login(email: string, password: string): Promise<void> {
    const tokens = await this.json<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    this.token = tokens.accessToken;
  }

  upload(file: string, title: string): Promise<{ id: string; status: string }> {
    const form = new FormData();
    form.set(
      'file',
      new Blob([readFileSync(file)], { type: 'application/pdf' }),
      basename(file),
    );
    form.set('title', title);
    form.set('visibility', 'private');
    return this.json('/documents', { method: 'POST', body: form });
  }

  documents(
    page: number,
    limit: number,
  ): Promise<{
    items: { id: string; title: string; status: string }[];
    total: number;
  }> {
    return this.json(`/documents?page=${page}&limit=${limit}`);
  }

  status(id: string): Promise<{
    status: string;
    chunkCount: number;
    pageCount: number | null;
    errorMessage: string | null;
  }> {
    return this.json(`/documents/${id}/status`);
  }

  search(params: {
    q: string;
    mode: string;
    limit: number;
    rerank: boolean;
    documentId?: string;
  }): Promise<SearchResponse> {
    const query = new URLSearchParams({
      q: params.q,
      mode: params.mode,
      limit: String(params.limit),
      rerank: String(params.rerank),
    });
    if (params.documentId) {
      query.set('documentId', params.documentId);
    }
    return this.json(`/search?${query}`);
  }

  async ask(body: {
    question: string;
    mode?: string;
    rerank?: boolean;
    documentId?: string;
  }): Promise<QueryResult> {
    const startedAt = performance.now();
    const response = await fetch(`${this.base}/query`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        accept: 'text/event-stream',
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body) {
      throw new HttpError(response.status, await response.text());
    }

    const result: QueryResult = {
      sources: [],
      done: null,
      error: null,
      ttftMs: null,
      totalMs: 0,
    };
    for await (const event of readSse(response.body)) {
      const data = JSON.parse(event.data);
      if (event.event === 'meta') {
        result.sources = data.sources;
      } else if (event.event === 'token' && result.ttftMs === null) {
        result.ttftMs = performance.now() - startedAt;
      } else if (event.event === 'done') {
        result.done = data;
      } else if (event.event === 'error') {
        result.error = data;
      }
    }
    result.totalMs = performance.now() - startedAt;
    return result;
  }
}
