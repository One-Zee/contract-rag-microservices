import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '@app/config';
import {
  type AuthContext,
  canManage,
  canRead,
  DOCUMENT_STATUSES,
  DOCUMENT_VISIBILITIES,
  type DocumentDto,
  type DocumentStatusDto,
  isAcceptedMimeType,
  LIST_LIMIT_MAX,
  type ListDocumentsRpcPayload,
  type PaginatedDocumentsDto,
  rpcBadRequest,
  rpcForbidden,
  rpcNotFound,
  rpcPayloadTooLarge,
  rpcUnsupportedMediaType,
  type UpdateDocumentRpcPayload,
  type UploadDocumentRpcPayload,
} from '@app/common';
import { sniffMimeType } from '../extraction/text-extractor.js';
import { ProcessingQueue } from '../pipeline/processing-queue.js';
import { StorageService, storageKeyFor } from '../storage/storage.service.js';
import { ChunksRepository } from './chunks.repository.js';
import {
  type DocumentRecord,
  DocumentsRepository,
} from './documents.repository.js';

const FILENAME_MAX = 255;
const TITLE_MAX = 200;

/** Longest base64 text that can encode `bytes` bytes — checked before decoding. */
export const base64LengthFor = (bytes: number): number =>
  Math.ceil(bytes / 3) * 4;

/**
 * The name is kept for display only. Directory parts and control characters
 * are dropped; the storage key never sees it at all (`storageKeyFor`).
 */
export const sanitizeFilename = (raw: string): string =>
  raw
    .split(/[\\/]/)
    .pop()!
    .replace(/[\p{Cc}]/gu, '')
    .trim()
    .slice(0, FILENAME_MAX);

const titleFrom = (filename: string): string =>
  (filename.replace(/\.[^.]+$/, '') || filename).slice(0, TITLE_MAX);

/** The gateway validated the DTO already; the service does not rely on that (ADR 006). */
const isVisibility = (value: unknown) =>
  (DOCUMENT_VISIBILITIES as readonly unknown[]).includes(value);
const isStatus = (value: unknown) =>
  (DOCUMENT_STATUSES as readonly unknown[]).includes(value);
const isPositiveInt = (value: unknown, max: number) =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly documents: DocumentsRepository,
    private readonly chunks: ChunksRepository,
    private readonly storage: StorageService,
    private readonly queue: ProcessingQueue,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Validates, stores the original, creates the row, queues the processing.
   * The reply goes out with status `uploaded`; the client polls `status`.
   */
  async upload(
    auth: AuthContext,
    payload: UploadDocumentRpcPayload,
  ): Promise<DocumentDto> {
    const { mimeType } = payload;
    if (!isAcceptedMimeType(mimeType)) {
      throw rpcUnsupportedMediaType('Only PDF and DOCX files are accepted');
    }
    const maxBytes = this.config.uploadMaxBytes;
    if (
      typeof payload.contentBase64 !== 'string' ||
      payload.contentBase64.length > base64LengthFor(maxBytes)
    ) {
      // Checked on the encoded length, before a single byte is decoded.
      throw rpcPayloadTooLarge(`File exceeds the limit of ${maxBytes} bytes`);
    }
    const bytes = Buffer.from(payload.contentBase64, 'base64');
    if (bytes.length === 0) {
      throw rpcBadRequest('File is empty');
    }
    if (bytes.length > maxBytes) {
      throw rpcPayloadTooLarge(`File exceeds the limit of ${maxBytes} bytes`);
    }
    if (sniffMimeType(bytes) !== mimeType) {
      throw rpcBadRequest('File content does not match its declared type');
    }
    const originalFilename = sanitizeFilename(
      String(payload.originalFilename ?? ''),
    );
    if (originalFilename.length === 0) {
      throw rpcBadRequest('A file name is required');
    }
    const visibility = payload.visibility ?? 'private';
    if (!isVisibility(visibility)) {
      throw rpcBadRequest('visibility must be private or shared');
    }
    const title =
      payload.title?.trim().slice(0, TITLE_MAX) || titleFrom(originalFilename);

    const id = randomUUID();
    const storageKey = storageKeyFor(id, mimeType);
    await this.storage.put(storageKey, bytes, mimeType);

    let record: DocumentRecord;
    try {
      record = await this.documents.create({
        id,
        title,
        originalFilename,
        storageKey,
        mimeType,
        fileSize: bytes.length,
        visibility,
        uploadedBy: auth.userId,
      });
    } catch (error) {
      // No row, no orphan: the object is removed again, best effort.
      await this.storage.delete(storageKey).catch((cleanupError: unknown) => {
        this.logger.error(
          `Could not remove ${storageKey} after a failed insert: ${String(cleanupError)}`,
        );
      });
      throw error;
    }

    this.queue.enqueue(id);
    this.logger.log(
      `Document ${id} uploaded by ${auth.userId} (${bytes.length} bytes, ${mimeType})`,
    );
    return DocumentsService.toDocumentDto(record);
  }

  async list(
    auth: AuthContext,
    payload: ListDocumentsRpcPayload,
  ): Promise<PaginatedDocumentsDto> {
    const { page, limit, status } = payload;
    if (
      !isPositiveInt(page, Number.MAX_SAFE_INTEGER) ||
      !isPositiveInt(limit, LIST_LIMIT_MAX)
    ) {
      throw rpcBadRequest(
        `page must be >= 1 and limit between 1 and ${LIST_LIMIT_MAX}`,
      );
    }
    if (status !== undefined && !isStatus(status)) {
      throw rpcBadRequest('Unknown status filter');
    }
    const { items, total } = await this.documents.list({
      viewer: auth,
      status,
      page,
      limit,
    });
    return {
      items: items.map(DocumentsService.toDocumentDto),
      total,
      page,
      limit,
    };
  }

  async get(auth: AuthContext, documentId: string): Promise<DocumentDto> {
    return DocumentsService.toDocumentDto(
      await this.readable(auth, documentId),
    );
  }

  async status(
    auth: AuthContext,
    documentId: string,
  ): Promise<DocumentStatusDto> {
    const document = await this.readable(auth, documentId);
    return {
      id: document.id,
      status: document.status,
      pageCount: document.pageCount,
      chunkCount: await this.chunks.countForDocument(documentId),
      errorMessage: document.errorMessage,
      updatedAt: document.updatedAt,
    };
  }

  async update(
    auth: AuthContext,
    payload: UpdateDocumentRpcPayload,
  ): Promise<DocumentDto> {
    const document = await this.manageable(auth, payload.documentId);
    const patch: { title?: string; visibility?: DocumentRecord['visibility'] } =
      {};
    if (payload.title !== undefined) {
      const title = String(payload.title).trim().slice(0, TITLE_MAX);
      if (title.length === 0) {
        throw rpcBadRequest('title must not be empty');
      }
      patch.title = title;
    }
    if (payload.visibility !== undefined) {
      if (!isVisibility(payload.visibility)) {
        throw rpcBadRequest('visibility must be private or shared');
      }
      patch.visibility = payload.visibility;
    }
    if (Object.keys(patch).length === 0) {
      throw rpcBadRequest('Nothing to update');
    }
    const updated = await this.documents.update(document.id, patch);
    return DocumentsService.toDocumentDto(updated ?? document);
  }

  /**
   * Object first, row second: if the store refuses, the row survives and the
   * delete can be retried; the other order would leave an orphan object.
   */
  async delete(auth: AuthContext, documentId: string): Promise<void> {
    const document = await this.manageable(auth, documentId);
    await this.storage.delete(document.storageKey);
    await this.documents.delete(document.id);
    this.logger.log(`Document ${document.id} deleted by ${auth.userId}`);
  }

  /** 404 for both "no such document" and "not yours to see" — existence is not revealed. */
  private async readable(
    auth: AuthContext,
    documentId: string,
  ): Promise<DocumentRecord> {
    const document = await this.documents.findById(documentId);
    if (!document || !canRead(document, auth)) {
      throw rpcNotFound('Document does not exist');
    }
    return document;
  }

  private async manageable(
    auth: AuthContext,
    documentId: string,
  ): Promise<DocumentRecord> {
    const document = await this.readable(auth, documentId);
    if (!canManage(document, auth)) {
      throw rpcForbidden('Only the uploader or an admin may change a document');
    }
    return document;
  }

  private static toDocumentDto(record: DocumentRecord): DocumentDto {
    const { storageKey: _storageKey, ...dto } = record;
    return dto;
  }
}
