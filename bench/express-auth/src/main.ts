import { startTelemetry } from '@app/telemetry/start.js';

// The same entry as every Nest service: instrumentation hooks first,
// the application after them. Telemetry is configured identically for every
// target a benchmark compares.
await startTelemetry('express-auth');
await import('./server.js');
