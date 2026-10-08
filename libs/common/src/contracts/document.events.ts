import { randomUUID } from 'node:crypto';

/**
 * Routing keys on the `clauseiq.events` exchange. Events carry no identity
 * there is no caller to verify, the broker is the trust boundary.
 *
 * `document.indexed` has no consumer yet — a topic exchange drops a message
 * nobody is bound to, which is fine until phase 5/6 gives the gateway a reason
 * to listen (notifications). Publishing it now keeps the ingestion → indexing
 * chain symmetric and observable in the management UI.
 */
export const DOCUMENT_EVENTS = {
  CHUNKED: 'document.chunked',
  INDEXED: 'document.indexed',
} as const;

export type DocumentEventType =
  (typeof DOCUMENT_EVENTS)[keyof typeof DOCUMENT_EVENTS];

export interface DomainEvent<TType extends string = string> {
  /** Also the AMQP `messageId`, so a consumer can deduplicate redeliveries. */
  eventId: string;
  type: TType;
  /** ISO-8601 */
  occurredAt: string;
}

/**
 * A claim-check, not a payload: the chunks are already in Postgres with
 * `embedding = NULL`, the event only says which document is ready.
 */
export interface DocumentChunkedEvent extends DomainEvent<
  typeof DOCUMENT_EVENTS.CHUNKED
> {
  documentId: string;
  uploadedBy: string;
  chunkCount: number;
}

export const documentChunkedEvent = (
  payload: Omit<DocumentChunkedEvent, keyof DomainEvent>,
): DocumentChunkedEvent => ({
  eventId: randomUUID(),
  type: DOCUMENT_EVENTS.CHUNKED,
  occurredAt: new Date().toISOString(),
  ...payload,
});

/** Every chunk of the document has its embedding; the document is searchable. */
export interface DocumentIndexedEvent extends DomainEvent<
  typeof DOCUMENT_EVENTS.INDEXED
> {
  documentId: string;
  uploadedBy: string;
  chunkCount: number;
}

export const documentIndexedEvent = (
  payload: Omit<DocumentIndexedEvent, keyof DomainEvent>,
): DocumentIndexedEvent => ({
  eventId: randomUUID(),
  type: DOCUMENT_EVENTS.INDEXED,
  occurredAt: new Date().toISOString(),
  ...payload,
});
