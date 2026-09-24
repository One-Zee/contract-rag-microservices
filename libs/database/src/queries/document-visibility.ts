import { eq, or, type SQL } from 'drizzle-orm';
import type { AuthContext } from '@app/common';
import { documents } from '../schema/documents.js';

/**
 * The listing form of `canRead` from `@app/common` — the two must agree.
 * `undefined` means "no filter", which Drizzle treats as no WHERE at all.
 *
 * Two services build queries with it: ingestion lists documents, retrieval
 * filters the hybrid search *before* ranking. The order matters — filtering
 * the results afterwards would hand a reader fewer than `k` chunks and make
 * recall@k depend on which account ran the evaluation (plan §8.4, ADR 014).
 *
 * It lives in `@app/database` rather than next to `canRead` because it needs
 * the `documents` table: the dependency goes database → common, never back.
 */
export const documentVisibilityCondition = (
  viewer: AuthContext,
): SQL | undefined => {
  if (viewer.roles.includes('admin')) {
    return undefined;
  }
  const shared = eq(documents.visibility, 'shared');
  if (viewer.roles.includes('analyst')) {
    return or(shared, eq(documents.uploadedBy, viewer.userId));
  }
  return shared;
};
