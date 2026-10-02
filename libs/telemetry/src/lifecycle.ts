/**
 * The seam between `start.ts`, which only `main.ts` imports, and the Nest side
 * of the library. Keeping the SDK handle here means importing `@app/telemetry`
 * from application code (or from a test) never loads the SDK itself.
 */

export interface TelemetryStatus {
  /** OTLP/HTTP base URL traces go to, or `null` when tracing is off. */
  tracesEndpoint: string | null;
  /** Port of the Prometheus scrape endpoint, or `null` when metrics are off. */
  metricsPort: number | null;
}

let status: TelemetryStatus = { tracesEndpoint: null, metricsPort: null };
let shutdown: (() => Promise<void>) | undefined;

export function setTelemetryStarted(
  started: TelemetryStatus,
  onShutdown: () => Promise<void>,
): void {
  status = started;
  shutdown = onShutdown;
}

export function telemetryStatus(): TelemetryStatus {
  return status;
}

/**
 * Flushes the batch span processor and closes the metrics endpoint. Safe to
 * call when nothing was started, and safe to call twice.
 */
export async function shutdownTelemetry(): Promise<void> {
  const pending = shutdown;
  shutdown = undefined;
  await pending?.();
}
