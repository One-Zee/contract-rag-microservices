import { Module } from '@nestjs/common';
import { AppConfigModule, baseSchema, llmSchema } from '@app/config';
import { LlmServiceController } from './llm-service.controller.js';
import { LlmServiceService } from './llm-service.service.js';

@Module({
  // Konstrukcija prompta i poziv modela; do baze dolazi preko retrieval-servisa,
  // pa mu DATABASE_URL nije potreban.
  imports: [AppConfigModule.forRoot(baseSchema.concat(llmSchema))],
  controllers: [LlmServiceController],
  providers: [LlmServiceService],
})
export class LlmServiceModule {}
