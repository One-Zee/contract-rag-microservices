import { Injectable } from '@nestjs/common';

@Injectable()
export class IngestionServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
