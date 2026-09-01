import { Module } from '@nestjs/common';
import { LlmServiceController } from './llm-service.controller.js';
import { LlmServiceService } from './llm-service.service.js';

@Module({
  imports: [],
  controllers: [LlmServiceController],
  providers: [LlmServiceService],
})
export class LlmServiceModule {}
