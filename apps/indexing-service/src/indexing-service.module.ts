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
  // Konzumira document.chunked (RabbitMQ), generiše embeddinge (llm) i upisuje
  // vektore u pgvector (baza).
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
