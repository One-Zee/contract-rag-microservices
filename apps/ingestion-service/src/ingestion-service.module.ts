import { Module } from '@nestjs/common';
import { IngestionServiceController } from './ingestion-service.controller.js';
import { IngestionServiceService } from './ingestion-service.service.js';

@Module({
  imports: [],
  controllers: [IngestionServiceController],
  providers: [IngestionServiceService],
})
export class IngestionServiceModule {}
