import type { AuthenticatedRpcPayload } from './auth.patterns.js';
import type { SearchMode } from './search.types.js';

/**
 * The message contract for `retrieval-service`. Same rule as `AUTH_PATTERNS`:
 * runtime coupling over TCP exists only here.
 *
 * Two callers, eventually: the gateway's `GET /search` (evaluation and
 * debugging, no LLM in the way) and `llm-service` in phase 5, which asks for
 * the context it is about to put in a prompt.
 */
export const RETRIEVAL_PATTERNS = {
  SEARCH: 'retrieval.search',
} as const;

export interface SearchRpcPayload extends AuthenticatedRpcPayload {
  /** The user's question, verbatim — it is embedded and parsed as a tsquery. */
  query: string;
  mode: SearchMode;
  /** Falls back to `SEARCH_TOP_K` when the caller has no opinion. */
  limit?: number;
  /** Narrows the search to a single document; visibility still applies. */
  documentId?: string;
  /** Overrides whether the configured reranker runs for this request. */
  rerank?: boolean;
}
