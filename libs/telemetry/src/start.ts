import { existsSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createAddHookMessageChannel } from 'import-in-the-middle';
// The fragment, not the `@app/config` barrel: the barrel pulls in
// `@nestjs/config`, and nothing but OpenTelemetry may load before the hooks.
import { telemetrySchema } from '@app/config/schemas/telemetry.schema.js';
import { createInstrumentations } from './instrumentations.js';
import { setTelemetryStarted } from './lifecycle.js';
import { RedactingSpanExporter } from './redaction.js';

/**
 * Locally the variables live in `.env`, which `ConfigModule` reads only once
 * Nest is running — too late for this. Only `OTEL_*` keys are taken, and only
 * when the environment does not already set them, so `ConfigModule` goes on
 * parsing everything else exactly as before. In a container `.env` does not
 * exist and the environment is the only source.
 */
function loadOtelVariablesFromDotEnv(): void {
  if (!existsSync('.env')) return;
  const parsed = parseEnv(readFileSync('.env', 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('OTEL_') && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Starts OpenTelemetry for this process. Every `main.ts` awaits it and only
 * then imports `bootstrap.js` dynamically: in ESM every static import is
 * loaded before the first statement runs, so a hook registered from the same
 * module graph would arrive after Express, pg and the AWS SDK were already
 * loaded unpatched (ADR 019).
 *
 * Opt-in per signal: no `OTEL_EXPORTER_OTLP_ENDPOINT` means no tracing, no
 * `OTEL_METRICS_EXPORTER=prometheus` means no metrics endpoint, and neither
 * means nothing is started at all — the OpenTelemetry API then stays a no-op,
 * exactly as in tests.
 */
export async function startTelemetry(serviceName: string): Promise<void> {
  loadOtelVariablesFromDotEnv();

  const { value: env, error } = telemetrySchema.validate(process.env, {
    allowUnknown: true,
    abortEarly: false,
  });
  if (error) {
    throw new Error(`Invalid telemetry configuration: ${error.message}`);
  }

  // `.empty('')` in the schema has already turned an empty value into
  // `undefined`, so "set" and "on" are the same thing here.
  const tracesEndpoint: string | null = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
  const metricsPort: number | null =
    env.OTEL_METRICS_EXPORTER === 'prometheus'
      ? env.OTEL_EXPORTER_PROMETHEUS_PORT
      : null;
  if (tracesEndpoint === null && metricsPort === null) return;

  // ESM imports are invisible to require-in-the-middle; import-in-the-middle
  // is the loader that lets the instrumentations patch `pg`, `express` and the
  // AWS SDK when the bundle imports them. The message channel tells the loader
  // which modules the instrumentations asked for, so nothing else is wrapped.
  // Resolved from the working directory, not from `import.meta.url`: the
  // bundler rewrites the latter to a source path that does not exist in the
  // image.
  const { registerOptions, waitForAllMessagesAcknowledged } =
    createAddHookMessageChannel();
  register(
    'import-in-the-middle/hook.mjs',
    pathToFileURL('./'),
    registerOptions,
  );

  const sdk = new NodeSDK({
    serviceName,
    resource: resourceFromAttributes({
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    instrumentations: createInstrumentations(),
    // Explicit empty lists, not `undefined`: given nothing, the SDK falls back
    // to the environment and defaults every signal to an OTLP exporter —
    // including metrics and logs, which Jaeger does not accept.
    spanProcessors:
      tracesEndpoint === null
        ? []
        : [
            new BatchSpanProcessor(
              new RedactingSpanExporter(new OTLPTraceExporter()),
            ),
          ],
    metricReaders:
      metricsPort === null
        ? []
        : [new PrometheusExporter({ port: metricsPort })],
    logRecordProcessors: [],
  });
  sdk.start();
  await waitForAllMessagesAcknowledged();

  setTelemetryStarted({ tracesEndpoint, metricsPort }, () => sdk.shutdown());
}
