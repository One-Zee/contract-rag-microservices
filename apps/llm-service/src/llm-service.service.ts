import { Injectable } from '@nestjs/common';

@Injectable()
export class LlmServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
