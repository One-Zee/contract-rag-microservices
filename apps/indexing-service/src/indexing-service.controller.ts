import { Controller, Get } from '@nestjs/common';
import { IndexingServiceService } from './indexing-service.service.js';

@Controller()
export class IndexingServiceController {
  constructor(
    private readonly indexingServiceService: IndexingServiceService,
  ) {}

  @Get()
  getHello(): string {
    return this.indexingServiceService.getHello();
  }
}
