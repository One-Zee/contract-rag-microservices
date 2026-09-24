/**
 * Which branches of the hybrid search run.
 *
 * `hybrid` is the pipeline the system is built around; the other two exist
 * because the plan compares them against it (vector only, lexical only,
 * hybrid + RRF, hybrid + RRF + rerank). Making the mode a request parameter
 * means the comparison is four requests, not four builds.
 */
export const SEARCH_MODES = ['hybrid', 'vector', 'lexical'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
