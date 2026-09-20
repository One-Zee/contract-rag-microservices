import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  authSchema,
  baseSchema,
  chunkingSchema,
  databaseSchema,
  messagingSchema,
  storageSchema,
  uploadSchema,
} from '@app/config';
import { JwtVerifierModule } from '@app/common';
import { DrizzleModule } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { ChunksRepository } from './documents/chunks.repository.js';
import { DocumentsController } from './documents/documents.controller.js';
import { DocumentsRepository } from './documents/documents.repository.js';
import { DocumentsService } from './documents/documents.service.js';
import { TextExtractionService } from './extraction/text-extractor.js';
import { IngestionPipeline } from './pipeline/ingestion-pipeline.js';
import { ProcessingQueue } from './pipeline/processing-queue.js';
import { StorageModule } from './storage/storage.module.js';

/**
 * Accepts the upload (storage), writes the document and its chunks
 * (database), publishes `document.chunked` (messaging). Verifies tokens with
 * the public key only — `JwtVerifierModule`, never the signing key (ADR 004).
 */
@Module({
  imports: [
    AppConfigModule.forRoot(
      baseSchema
        .concat(authSchema)
        .concat(databaseSchema)
        .concat(storageSchema)
        .concat(messagingSchema)
        .concat(uploadSchema)
        .concat(chunkingSchema),
    ),
    JwtVerifierModule,
    DrizzleModule,
    StorageModule,
    MessagingModule,
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentsRepository,
    ChunksRepository,
    TextExtractionService,
    IngestionPipeline,
    ProcessingQueue,
  ],
})
export class IngestionServiceModule {}
