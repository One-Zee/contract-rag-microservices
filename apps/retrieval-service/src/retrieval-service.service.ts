import { Injectable } from '@nestjs/common';

@Injectable()
export class RetrievalServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
