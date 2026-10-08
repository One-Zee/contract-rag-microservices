import { Controller, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  type AuthContext,
  CurrentUser,
  type DocumentDto,
  type DocumentIdRpcPayload,
  type DocumentStatusDto,
  INGESTION_PATTERNS,
  type ListDocumentsRpcPayload,
  type PaginatedDocumentsDto,
  Roles,
  RolesGuard,
  RpcAuthGuard,
  type UpdateDocumentRpcPayload,
  type UploadDocumentRpcPayload,
} from '@app/common';
import { DocumentsService } from './documents.service.js';

@Controller()
@UseGuards(RpcAuthGuard, RolesGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Roles('admin', 'analyst')
  @MessagePattern(INGESTION_PATTERNS.DOCUMENT_UPLOAD)
  upload(
    @Payload() payload: UploadDocumentRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<DocumentDto> {
    return this.documents.upload(auth, payload);
  }

  @MessagePattern(INGESTION_PATTERNS.DOCUMENT_LIST)
  list(
    @Payload() payload: ListDocumentsRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<PaginatedDocumentsDto> {
    return this.documents.list(auth, payload);
  }

  @MessagePattern(INGESTION_PATTERNS.DOCUMENT_GET)
  get(
    @Payload() payload: DocumentIdRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<DocumentDto> {
    return this.documents.get(auth, payload.documentId);
  }

  @MessagePattern(INGESTION_PATTERNS.DOCUMENT_STATUS)
  status(
    @Payload() payload: DocumentIdRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<DocumentStatusDto> {
    return this.documents.status(auth, payload.documentId);
  }

  @MessagePattern(INGESTION_PATTERNS.DOCUMENT_UPDATE)
  update(
    @Payload() payload: UpdateDocumentRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<DocumentDto> {
    return this.documents.update(auth, payload);
  }

  @MessagePattern(INGESTION_PATTERNS.DOCUMENT_DELETE)
  async delete(
    @Payload() payload: DocumentIdRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<{ deleted: true }> {
    await this.documents.delete(auth, payload.documentId);
    // An explicit reply value: `undefined` is dropped by JSON serialisation
    // and the gateway would have nothing to map to its 204.
    return { deleted: true };
  }
}
