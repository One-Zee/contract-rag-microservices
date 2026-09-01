import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service.js';

@Module({
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
