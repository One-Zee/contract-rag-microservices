import type { AuthenticatedRpcPayload } from './auth.patterns.js';
import type { SearchMode } from './search.types.js';

/**
 * The message contract for `llm-service`. Same rule as `AUTH_PATTERNS`:
 * runtime coupling over TCP exists only here.
 *
 * `QUERY` is unusual among this repo's patterns in that its handler returns an
 * Observable rather than a value: Nest's TCP transport delivers every emission
 * as its own packet, which is what lets the gateway turn the reply into an SSE
 * stream without llm-service ever speaking HTTP.
 *
 * `CANCEL` exists because that transport carries no cancellation. Unsubscribing
 * from a `send()` only deletes a local routing entry — the server is never
 * told, keeps generating, and keeps being billed. So the gateway asks, by
 * message, for what an unsubscribe cannot say.
 *
 * **Redaction obligation :** `accessToken` must be on the
 * OpenTelemetry redaction list before the first span is exported — and so must
 * `question`, because a question about a contract quotes the contract.
 */
export const LLM_PATTERNS = {
  QUERY: 'llm.query',
  HISTORY: 'llm.query.history',
  CANCEL: 'llm.query.cancel',
} as const;

export interface AskQuestionRpcPayload extends AuthenticatedRpcPayload {
  /** The user's question, verbatim; sanitised inside the service, not here. */
  question: string;
  /** Narrows retrieval to a single document; visibility still applies. */
  documentId?: string;
  /** Which retrieval branches run; defaults to `hybrid`. */
  mode?: SearchMode;
  /** Context chunks to ask retrieval for; defaults to `QUERY_CONTEXT_CHUNKS`. */
  limit?: number;
  /** Overrides whether retrieval's configured reranker runs. */
  rerank?: boolean;
}

export interface QueryHistoryRpcPayload extends AuthenticatedRpcPayload {
  page: number;
  limit: number;
}

export interface CancelQueryRpcPayload extends AuthenticatedRpcPayload {
  /** From the `meta` event of the stream being abandoned. */
  queryId: string;
}
