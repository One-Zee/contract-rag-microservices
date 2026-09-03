import { Controller, Get } from '@nestjs/common';
import { RetrievalServiceService } from './retrieval-service.service.js';

@Controller()
export class RetrievalServiceController {
  constructor(
    private readonly retrievalServiceService: RetrievalServiceService,
  ) {}

  @Get()
  getHello(): string {
    return this.retrievalServiceService.getHello();
  }
}
