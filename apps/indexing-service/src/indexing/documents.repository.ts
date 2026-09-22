import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDatabase, documents } from '@app/database';
import type { DocumentStatus } from '@app/common';

/** The columns indexing needs to decide and to report — nothing about content or visibility. */
export interface IndexableDocument {
  id: string;
  status: DocumentStatus;
  uploadedBy: string;
}

export interface DocumentStatusPatch {
  status: DocumentStatus;
  errorMessage: string | null;
}

/**
 * indexing-service's own view of `documents`: it never creates, lists or
 * deletes a row, only moves it between `chunked`, `indexing`, `indexed` and
 * `failed`. Ownership and visibility stay ingestion-service's business.
 */
@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  async findById(id: string): Promise<IndexableDocument | undefined> {
    const [row] = await this.db
      .select({
        id: documents.id,
        status: documents.status,
        uploadedBy: documents.uploadedBy,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return row;
  }

  /** Every write bumps `updatedAt` — the polling client's only clock. */
  async setStatus(id: string, patch: DocumentStatusPatch): Promise<void> {
    await this.db
      .update(documents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(documents.id, id));
  }

  /** Documents whose event was never consumed, or whose indexing a crash cut short. */
  async findIdsByStatus(statuses: DocumentStatus[]): Promise<string[]> {
    const rows = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.status, statuses))
      .orderBy(documents.createdAt);
    return rows.map((row) => row.id);
  }
}
