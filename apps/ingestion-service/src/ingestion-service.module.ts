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
  // Prima upload (S3), piše dokument i segmente (baza), objavljuje
  // document.chunked (RabbitMQ).
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
