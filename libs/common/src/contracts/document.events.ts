import { randomUUID } from 'node:crypto';

export const DOCUMENT_EVENTS = {
  CHUNKED: 'document.chunked',
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
