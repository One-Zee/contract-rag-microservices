import { Controller, Get } from '@nestjs/common';
import { LlmServiceService } from './llm-service.service.js';

@Controller()
export class LlmServiceController {
  constructor(private readonly llmServiceService: LlmServiceService) {}

  @Get()
  getHello(): string {
    return this.llmServiceService.getHello();
  }
}
