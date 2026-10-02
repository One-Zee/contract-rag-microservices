import { startTelemetry } from '@app/telemetry/start.js';

// Nothing else is imported statically. In ESM every static import is loaded
// before the first statement runs, so the application would arrive before the
// instrumentation hooks did; it comes in through a dynamic import once they
// are in place (ADR 019).
await startTelemetry('indexing-service');
await import('./bootstrap.js');
