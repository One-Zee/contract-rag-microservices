import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  baseSchema,
  databaseSchema,
  llmSchema,
  messagingSchema,
} from '@app/config';
import { IndexingServiceController } from './indexing-service.controller.js';
import { IndexingServiceService } from './indexing-service.service.js';

@Module({
  // Consumes document.chunked (RabbitMQ), generates embeddings (llm) and writes
  // vectors into pgvector (database).
  imports: [
    AppConfigModule.forRoot(
      baseSchema
        .concat(databaseSchema)
        .concat(messagingSchema)
        .concat(llmSchema),
    ),
  ],
  controllers: [IndexingServiceController],
  providers: [IndexingServiceService],
})
export class IndexingServiceModule {}
