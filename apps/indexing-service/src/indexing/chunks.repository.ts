import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { chunks, DRIZZLE, type DrizzleDatabase } from '@app/database';

export interface UnembeddedChunk {
  id: string;
  content: string;
}

export interface ChunkEmbedding {
  id: string;
  embedding: number[];
}

/**
 * The `embedding` column is the only thing indexing-service writes. Rows are
 * ingestion-service's: created there, replaced there on a re-run (which resets
 * the embedding to NULL and so re-queues the document here).
 */
@Injectable()
export class ChunksRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * The next batch still waiting for a vector, in document order. Selecting
   * on `embedding IS NULL` is what makes a re-run pick up exactly where the
   * previous one stopped — after a crash, a redelivered event or a boot sweep.
   */
  async findUnembedded(
    documentId: string,
    limit: number,
  ): Promise<UnembeddedChunk[]> {
    return this.db
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
      .where(and(eq(chunks.documentId, documentId), isNull(chunks.embedding)))
      .orderBy(asc(chunks.chunkIndex))
      .limit(limit);
  }

  /**
   * One transaction per batch, so a crash mid-batch leaves whole batches, not
   * half of one. The `IS NULL` guard keeps two workers on the same document
   * from overwriting each other — they would write the same vector anyway.
   */
  async setEmbeddings(rows: ChunkEmbedding[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db.transaction(async (tx) => {
      for (const { id, embedding } of rows) {
        await tx
          .update(chunks)
          .set({ embedding })
          .where(and(eq(chunks.id, id), isNull(chunks.embedding)));
      }
    });
  }

  async countForDocument(documentId: string): Promise<number> {
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(chunks)
      .where(eq(chunks.documentId, documentId));
    return total;
  }
}
