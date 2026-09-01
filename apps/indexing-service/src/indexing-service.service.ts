import { Injectable } from '@nestjs/common';

@Injectable()
export class IndexingServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
