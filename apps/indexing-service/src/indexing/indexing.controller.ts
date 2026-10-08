import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { DOCUMENT_EVENTS, type DocumentChunkedEvent } from '@app/common';
import { acknowledge, deadLetter } from '@app/messaging';
import { DocumentIndexer } from './document-indexer.js';

/**
 * The `indexing` queue's consumer. No guards: events carry no identity, the
 * broker is the trust boundary.
 *
 * Every delivery ends in exactly one of `ack` or `nack` — Nest does neither
 * for an event handler, and one that throws leaves its message unacknowledged
 * until the channel closes (see `libs/messaging/src/consumer.ts`):
 *
 *   indexed / skipped / failed  → ack         the outcome is in the database
 *   deferred                    → dead-letter  transient; back to `chunked`, replay or sweep later
 *   anything thrown             → dead-letter  the database itself is unreachable
 */
@Controller()
export class IndexingController {
  private readonly logger = new Logger(IndexingController.name);

  constructor(private readonly indexer: DocumentIndexer) {}

  // `<string>` selects the plain `MethodDecorator` overload: Nest 12's typed
  // overload declares the handler as `(data, ...args: unknown[])`, which
  // under `strictFunctionTypes` rejects a `@Ctx() context: RmqContext`
  // parameter — the one a consumer with manual acks cannot do without.
  @EventPattern<string>(DOCUMENT_EVENTS.CHUNKED)
  async onDocumentChunked(
    @Payload() event: DocumentChunkedEvent,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const documentId = event?.documentId;
    if (typeof documentId !== 'string' || documentId.length === 0) {
      this.logger.error(
        `Dead-lettering a ${DOCUMENT_EVENTS.CHUNKED} without a documentId`,
      );
      deadLetter(context);
      return;
    }

    try {
      const outcome = await this.indexer.index(documentId);
      if (outcome.kind === 'deferred') {
        deadLetter(context);
        return;
      }
      acknowledge(context);
    } catch (error) {
      this.logger.error(
        `Dead-lettering ${event.eventId} for ${documentId}: ${String(error)}`,
      );
      deadLetter(context);
    }
  }
}
