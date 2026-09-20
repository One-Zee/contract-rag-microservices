import { Module } from '@nestjs/common';
import { AppConfigModule, AppConfigService } from '@app/config';
import {
  createS3Client,
  S3_CLIENT,
  StorageService,
} from './storage.service.js';

/**
 * The client is a provider of its own (like `PG_POOL` in `DrizzleModule`) so
 * that `StorageService` can be unit-tested with a fake `send`.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: S3_CLIENT,
      inject: [AppConfigService],
      useFactory: createS3Client,
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
