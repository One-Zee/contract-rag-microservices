import { Module } from '@nestjs/common';
import { CommonService } from './common.service.js';

@Module({
  providers: [CommonService],
  exports: [CommonService],
})
export class CommonModule {}
