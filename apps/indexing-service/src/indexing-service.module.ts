import { Module } from '@nestjs/common';
import { IndexingServiceController } from './indexing-service.controller.js';
import { IndexingServiceService } from './indexing-service.service.js';

@Module({
  imports: [],
  controllers: [IndexingServiceController],
  providers: [IndexingServiceService],
})
export class IndexingServiceModule {}
