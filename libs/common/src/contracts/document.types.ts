export const DOCUMENT_STATUSES = [
  'uploaded',
  'parsing',
  'chunked',
  'indexing',
  'indexed',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * `private` — visible to the uploader and to admins.
 * `shared`  — visible to every authenticated user, readers included.
 */
export const DOCUMENT_VISIBILITIES = ['private', 'shared'] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];

/** MIME types ingestion accepts, mapped to the extension of the stored original. */
export const ACCEPTED_DOCUMENT_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
} as const;
export type AcceptedMimeType = keyof typeof ACCEPTED_DOCUMENT_TYPES;

export const isAcceptedMimeType = (value: string): value is AcceptedMimeType =>
  Object.hasOwn(ACCEPTED_DOCUMENT_TYPES, value);
