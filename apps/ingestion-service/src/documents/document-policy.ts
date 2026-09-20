import type { AuthContext, DocumentVisibility } from '@app/common';

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
 * `DocumentsRepository.visibilityCondition` is the same rule as SQL for
 * listing; the two must agree, and the documents e2e checks that they do.
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
