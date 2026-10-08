import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { map, type Observable } from 'rxjs';
import {
  DOCUMENT_VISIBILITIES,
  DocumentDto,
  type DocumentIdRpcPayload,
  DocumentStatusDto,
  INGESTION_PATTERNS,
  ListDocumentsQueryDto,
  type ListDocumentsRpcPayload,
  PaginatedDocumentsDto,
  Roles,
  RolesGuard,
  UpdateDocumentDto,
  type UpdateDocumentRpcPayload,
  UploadDocumentDto,
  type UploadDocumentRpcPayload,
} from '@app/common';
import { AccessToken } from '../auth/access-token.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { INGESTION_CLIENT } from '../clients/ingestion-client.module.js';
import { rpcToHttp } from '../common/rpc-to-http.js';
import { UPLOAD_FIELD, type UploadedContractFile } from './upload.options.js';

@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(INGESTION_CLIENT) private readonly ingestion: ClientProxy,
  ) {}

  /**
   * The file goes to ingestion-service base64-encoded inside the TCP payload.
   * Multer has already enforced `UPLOAD_MAX_BYTES` and the MIME
   * allow-list; `@Roles` here is the cheap first check, repeated on the
   * handler over there
   */
  @Post()
  @Roles('admin', 'analyst')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor(UPLOAD_FIELD))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload a contract (PDF or DOCX); processing continues in the background',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: [UPLOAD_FIELD],
      properties: {
        [UPLOAD_FIELD]: { type: 'string', format: 'binary' },
        title: { type: 'string', maxLength: 200 },
        visibility: { type: 'string', enum: [...DOCUMENT_VISIBILITIES] },
      },
    },
  })
  @ApiResponse({
    status: 202,
    type: DocumentDto,
    description: 'Accepted — poll /documents/{id}/status',
  })
  @ApiResponse({
    status: 400,
    description: 'No file, or content that does not match its type',
  })
  @ApiResponse({ status: 403, description: 'Readers cannot upload' })
  @ApiResponse({ status: 413, description: 'Larger than UPLOAD_MAX_BYTES' })
  @ApiResponse({ status: 415, description: 'Not a PDF or DOCX' })
  upload(
    @UploadedFile() file: UploadedContractFile | undefined,
    @Body() dto: UploadDocumentDto,
    @AccessToken() accessToken: string,
  ): Observable<DocumentDto> {
    if (!file) {
      throw new BadRequestException(
        `Multipart field "${UPLOAD_FIELD}" is required`,
      );
    }
    return this.ingestion
      .send<DocumentDto>(INGESTION_PATTERNS.DOCUMENT_UPLOAD, {
        accessToken,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        contentBase64: file.buffer.toString('base64'),
        title: dto.title,
        visibility: dto.visibility,
      } satisfies UploadDocumentRpcPayload)
      .pipe(rpcToHttp('ingestion'));
  }

  @Get()
  @ApiOperation({
    summary:
      'Documents visible to you — shared ones, your own as an analyst, all as an admin',
  })
  @ApiResponse({ status: 200, type: PaginatedDocumentsDto })
  list(
    @Query() query: ListDocumentsQueryDto,
    @AccessToken() accessToken: string,
  ): Observable<PaginatedDocumentsDto> {
    return this.ingestion
      .send<PaginatedDocumentsDto>(INGESTION_PATTERNS.DOCUMENT_LIST, {
        accessToken,
        page: query.page,
        limit: query.limit,
        status: query.status,
      } satisfies ListDocumentsRpcPayload)
      .pipe(rpcToHttp('ingestion'));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A single document' })
  @ApiResponse({ status: 200, type: DocumentDto })
  @ApiResponse({
    status: 404,
    description: 'Does not exist, or not visible to you',
  })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @AccessToken() accessToken: string,
  ): Observable<DocumentDto> {
    return this.ingestion
      .send<DocumentDto>(INGESTION_PATTERNS.DOCUMENT_GET, {
        accessToken,
        documentId: id,
      } satisfies DocumentIdRpcPayload)
      .pipe(rpcToHttp('ingestion'));
  }

  @Get(':id/status')
  @ApiOperation({
    summary: 'Processing status — poll until chunked/indexed or failed',
  })
  @ApiResponse({ status: 200, type: DocumentStatusDto })
  @ApiResponse({
    status: 404,
    description: 'Does not exist, or not visible to you',
  })
  status(
    @Param('id', ParseUUIDPipe) id: string,
    @AccessToken() accessToken: string,
  ): Observable<DocumentStatusDto> {
    return this.ingestion
      .send<DocumentStatusDto>(INGESTION_PATTERNS.DOCUMENT_STATUS, {
        accessToken,
        documentId: id,
      } satisfies DocumentIdRpcPayload)
      .pipe(rpcToHttp('ingestion'));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename or change visibility — uploader or admin' })
  @ApiResponse({ status: 200, type: DocumentDto })
  @ApiResponse({
    status: 403,
    description: 'Visible to you, but not yours to change',
  })
  @ApiResponse({
    status: 404,
    description: 'Does not exist, or not visible to you',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentDto,
    @AccessToken() accessToken: string,
  ): Observable<DocumentDto> {
    return this.ingestion
      .send<DocumentDto>(INGESTION_PATTERNS.DOCUMENT_UPDATE, {
        accessToken,
        documentId: id,
        title: dto.title,
        visibility: dto.visibility,
      } satisfies UpdateDocumentRpcPayload)
      .pipe(rpcToHttp('ingestion'));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete the document, its chunks and the stored original — uploader or admin',
  })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({
    status: 403,
    description: 'Visible to you, but not yours to delete',
  })
  @ApiResponse({
    status: 404,
    description: 'Does not exist, or not visible to you',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @AccessToken() accessToken: string,
  ): Observable<void> {
    return this.ingestion
      .send<{ deleted: true }>(INGESTION_PATTERNS.DOCUMENT_DELETE, {
        accessToken,
        documentId: id,
      } satisfies DocumentIdRpcPayload)
      .pipe(
        rpcToHttp('ingestion'),
        map(() => undefined),
      );
  }
}
