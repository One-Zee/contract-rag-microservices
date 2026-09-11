import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  baseSchema,
  databaseSchema,
  messagingSchema,
  storageSchema,
} from '@app/config';
import { IngestionServiceController } from './ingestion-service.controller.js';
import { IngestionServiceService } from './ingestion-service.service.js';

@Module({
  // Accepts the upload (S3), writes the document and its chunks (database),
  // publishes document.chunked (RabbitMQ).
  imports: [
    AppConfigModule.forRoot(
      baseSchema
        .concat(databaseSchema)
        .concat(storageSchema)
        .concat(messagingSchema),
    ),
  ],
  controllers: [IngestionServiceController],
  providers: [IngestionServiceService],
})
export class IngestionServiceModule {}
