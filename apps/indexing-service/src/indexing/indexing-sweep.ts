import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DocumentIndexer } from './document-indexer.js';
import { DocumentsRepository } from './documents.repository.js';

/**
 * The event is a trigger, the database is the truth: at boot, every document
 * still in `chunked` (its event was published while nobody consumed — phase 2
 * ran without this service — or was dead-lettered) or in `indexing` (a crash
 * mid-run) is indexed again, one after another, without waiting for a
 * message. The sweep runs in the background so `listen()` is not delayed,
 * and the indexer's in-flight set keeps it from colliding with the consumer
 * on the same document.
 *
 * Assumes a single instance, like ingestion-service's re-queue: two
 * instances would both sweep, which the `embedding IS NULL` filter makes
 * harmless but wasteful.
 */
@Injectable()
export class IndexingSweep
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(IndexingSweep.name);
  private stopped = false;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly indexer: DocumentIndexer,
    private readonly documents: DocumentsRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const ids = await this.documents.findIdsByStatus(['chunked', 'indexing']);
    if (ids.length === 0) {
      return;
    }
    this.logger.warn(
      `Sweeping ${ids.length} document(s) left in chunked/indexing by a previous run or an unconsumed event`,
    );
    this.running = this.sweep(ids);
  }

  /** Stops between documents; the one in progress is the indexer's to finish. */
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async sweep(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (this.stopped) {
        return;
      }
      try {
        await this.indexer.index(id);
      } catch (error) {
        // The indexer records what it can; this is the database being down.
        this.logger.error(`Sweep could not index ${id}: ${String(error)}`);
      }
    }
    this.logger.log(`Sweep finished: ${ids.length} document(s) visited`);
  }
}
