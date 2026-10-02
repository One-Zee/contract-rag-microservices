import {
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { shutdownTelemetry, telemetryStatus } from './lifecycle.js';

/**
 * Imported by every root module. Nothing to inject — the module exists for its
 * two lifecycle hooks: say once what telemetry is doing, and flush the last
 * batch of spans before the process exits. `onApplicationShutdown` rather than
 * `onModuleDestroy`, for the same reason the Postgres pool closes there
 * (ADR 007).
 */
@Module({})
export class TelemetryModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger('Telemetry');

  onApplicationBootstrap(): void {
    const { tracesEndpoint, metricsPort } = telemetryStatus();
    const traces = tracesEndpoint ? `traces → ${tracesEndpoint}` : 'no traces';
    const metrics = metricsPort
      ? `metrics → :${metricsPort}/metrics`
      : 'no metrics';
    this.logger.log(`${traces} · ${metrics}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}
