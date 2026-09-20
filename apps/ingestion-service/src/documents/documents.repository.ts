import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDatabase, documents } from '@app/database';
import type {
  AuthContext,
  DocumentStatus,
  DocumentVisibility,
} from '@app/common';

export interface DocumentRecord {
  id: string;
  title: string;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  fileSize: number;
  status: DocumentStatus;
  visibility: DocumentVisibility;
  pageCount: number | null;
  errorMessage: string | null;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateDocumentInput {
  /** Chosen by the caller, because the storage key is derived from it before the row exists. */
  id: string;
  title: string;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  fileSize: number;
  visibility: DocumentVisibility;
  uploadedBy: string;
}

export interface DocumentPatch {
  title?: string;
  visibility?: DocumentVisibility;
  status?: DocumentStatus;
  pageCount?: number | null;
  errorMessage?: string | null;
}

export interface ListDocumentsOptions {
  viewer: AuthContext;
  status?: DocumentStatus;
  page: number;
  limit: number;
}

export interface DocumentPage {
  items: DocumentRecord[];
  total: number;
}

@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  /**
   * The listing form of `canRead` in `document-policy.ts` — the two must
   * agree. `undefined` means "no filter", which Drizzle treats as no WHERE.
   */
  static visibilityCondition(viewer: AuthContext): SQL | undefined {
    if (viewer.roles.includes('admin')) {
      return undefined;
    }
    const shared = eq(documents.visibility, 'shared');
    if (viewer.roles.includes('analyst')) {
      return or(shared, eq(documents.uploadedBy, viewer.userId));
    }
    return shared;
  }

  async create(input: CreateDocumentInput): Promise<DocumentRecord> {
    const [row] = await this.db.insert(documents).values(input).returning();
    return row;
  }

  async findById(id: string): Promise<DocumentRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return row;
  }

  async list({
    viewer,
    status,
    page,
    limit,
  }: ListDocumentsOptions): Promise<DocumentPage> {
    const where = and(
      DocumentsRepository.visibilityCondition(viewer),
      status ? eq(documents.status, status) : undefined,
    );
    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(documents)
        .where(where)
        .orderBy(desc(documents.createdAt), desc(documents.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.db.select({ total: count() }).from(documents).where(where),
    ]);
    return { items, total };
  }

  /** Every write bumps `updatedAt` — the polling client's only clock. */
  async update(
    id: string,
    patch: DocumentPatch,
  ): Promise<DocumentRecord | undefined> {
    const [row] = await this.db
      .update(documents)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return row;
  }

  /** Chunks go with the row (`ON DELETE CASCADE`). */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(documents)
      .where(eq(documents.id, id))
      .returning({ id: documents.id });
    return deleted.length > 0;
  }

  /** Documents the pipeline never finished — re-queued at boot. */
  async findIdsByStatus(statuses: DocumentStatus[]): Promise<string[]> {
    const rows = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.status, statuses))
      .orderBy(documents.createdAt);
    return rows.map((row) => row.id);
  }
}
