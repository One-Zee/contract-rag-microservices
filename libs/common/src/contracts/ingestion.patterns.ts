import type { AuthenticatedRpcPayload } from './auth.patterns.js';
import type { DocumentStatus, DocumentVisibility } from './document.types.js';

/**
 * The message contract between the gateway and `ingestion-service`. Same rule
 * as `AUTH_PATTERNS`: runtime coupling over TCP exists only here.
 */
export const INGESTION_PATTERNS = {
  DOCUMENT_UPLOAD: 'ingestion.document.upload',
  DOCUMENT_LIST: 'ingestion.document.list',
  DOCUMENT_GET: 'ingestion.document.get',
  DOCUMENT_STATUS: 'ingestion.document.status',
  DOCUMENT_UPDATE: 'ingestion.document.update',
  DOCUMENT_DELETE: 'ingestion.document.delete',
} as const;

export interface UploadDocumentRpcPayload extends AuthenticatedRpcPayload {
  originalFilename: string;
  mimeType: string;
  contentBase64: string;
  title?: string;
  visibility?: DocumentVisibility;
}

export interface ListDocumentsRpcPayload extends AuthenticatedRpcPayload {
  page: number;
  limit: number;
  status?: DocumentStatus;
}

export interface DocumentIdRpcPayload extends AuthenticatedRpcPayload {
  documentId: string;
}

export interface UpdateDocumentRpcPayload extends DocumentIdRpcPayload {
  title?: string;
  visibility?: DocumentVisibility;
}
