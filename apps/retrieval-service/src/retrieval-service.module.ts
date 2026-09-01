import { Module } from '@nestjs/common';
import { RetrievalServiceController } from './retrieval-service.controller.js';
import { RetrievalServiceService } from './retrieval-service.service.js';

@Module({
  imports: [],
  controllers: [RetrievalServiceController],
  providers: [RetrievalServiceService],
})
export class RetrievalServiceModule {}
