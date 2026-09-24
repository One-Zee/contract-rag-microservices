import type { DocumentVisibility } from '../contracts/document.types.js';
import type { AuthContext } from './auth-context.js';

/** The slice of a document record the policy needs. */
export interface DocumentAccess {
  uploadedBy: string;
  visibility: DocumentVisibility;
}

/**
 * Who sees what:
 *
 *   reader  → every `shared` document
 *   analyst → every `shared` document, plus their own
 *   admin   → everything
 *
 * `documentVisibilityCondition` in `@app/database` is the same rule as SQL —
 * used both to list documents and to filter the hybrid search before ranking.
 * The two must agree, and the documents e2e checks that they do.
 *
 * It lives here rather than in a service because two services apply it:
 * ingestion decides who may read or change a document, retrieval decides whose
 * chunks may appear in a result. `no-cross-app-imports` makes sharing it any
 * other way impossible.
 */
export const isAdmin = (auth: AuthContext): boolean =>
  auth.roles.includes('admin');

export const isOwner = (document: DocumentAccess, auth: AuthContext): boolean =>
  document.uploadedBy === auth.userId;

export const canRead = (document: DocumentAccess, auth: AuthContext): boolean =>
  isAdmin(auth) ||
  document.visibility === 'shared' ||
  (auth.roles.includes('analyst') && isOwner(document, auth));

/** Change or delete: the uploader or an admin, never a mere reader of a shared document. */
export const canManage = (
  document: DocumentAccess,
  auth: AuthContext,
): boolean =>
  isAdmin(auth) || (auth.roles.includes('analyst') && isOwner(document, auth));
