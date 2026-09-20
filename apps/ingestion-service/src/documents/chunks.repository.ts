import { Inject, Injectable } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { chunks, DRIZZLE, type DrizzleDatabase } from '@app/database';

export interface NewChunk {
  chunkIndex: number;
  content: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  tokenCount: number;
}

/** Rows per INSERT: 6 parameters each, comfortably under Postgres' 65 535. */
const INSERT_BATCH = 500;

@Injectable()
export class ChunksRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * Delete-then-insert in one transaction, so a reader never sees a document
   * half-chunked and a re-run (crash recovery) cannot collide with the unique
   * `(document_id, chunk_index)` index. The embedding stays NULL — that is
   * indexing-service's column.
   */
  async replaceForDocument(
    documentId: string,
    drafts: NewChunk[],
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.delete(chunks).where(eq(chunks.documentId, documentId));
      for (let offset = 0; offset < drafts.length; offset += INSERT_BATCH) {
        const batch = drafts
          .slice(offset, offset + INSERT_BATCH)
          .map((draft) => ({ documentId, ...draft }));
        await tx.insert(chunks).values(batch);
      }
      return drafts.length;
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
