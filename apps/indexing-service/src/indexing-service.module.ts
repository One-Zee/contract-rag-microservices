import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  baseSchema,
  databaseSchema,
  embeddingsSchema,
  messagingSchema,
} from '@app/config';
import { DrizzleModule } from '@app/database';
import { EmbeddingsModule } from '@app/embeddings';
import { MessagingModule } from '@app/messaging';
import { ChunksRepository } from './indexing/chunks.repository.js';
import { DocumentIndexer } from './indexing/document-indexer.js';
import { DocumentsRepository } from './indexing/documents.repository.js';
import { IndexingController } from './indexing/indexing.controller.js';
import { IndexingSweep } from './indexing/indexing-sweep.js';

/**
 * Consumes `document.chunked` (messaging), turns chunks into vectors
 * (embeddings) and writes them into pgvector (database). No JWT material:
 * nothing here is called by a user.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(
      baseSchema
        .concat(databaseSchema)
        .concat(messagingSchema)
        .concat(embeddingsSchema),
    ),
    DrizzleModule,
    MessagingModule,
    EmbeddingsModule,
  ],
  controllers: [IndexingController],
  providers: [
    DocumentsRepository,
    ChunksRepository,
    DocumentIndexer,
    IndexingSweep,
  ],
})
export class IndexingServiceModule {}
