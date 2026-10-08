// `start.ts` is deliberately not exported: only `main.ts` imports it, by its
// own path, so that importing this barrel never loads the SDK.
export {
  shutdownTelemetry,
  telemetryStatus,
  type TelemetryStatus,
} from './lifecycle.js';
export * from './telemetry.module.js';
export * from './tracing.js';
