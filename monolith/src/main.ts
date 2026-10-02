import { startTelemetry } from '@app/telemetry/start.js';

// The same entry as every service's : telemetry first, and the
// application only through a dynamic import once the hooks are in place.
await startTelemetry('monolith');
await import('./bootstrap.js');
