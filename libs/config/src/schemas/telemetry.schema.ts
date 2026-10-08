import Joi from 'joi';

/**
 * OpenTelemetry — validated by `startTelemetry` in `@app/telemetry` **before**
 * Nest boots, and never composed into `AppConfigModule`: the SDK has to be
 * running before the first instrumented module is imported, which is long
 * before any DI container exists .
 *
 * The names are the OpenTelemetry specification's own, so the variables the
 * SDK reads by itself (`OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, …)
 * keep working alongside these. What the schema adds is what it adds
 * everywhere else : a wrong value stops the service at boot and names
 * the variable, instead of an exporter that silently sends nowhere.
 *
 * Both signals are opt-in. No endpoint means no tracing, and anything but
 * `prometheus` means no metrics endpoint — a developer who sets neither gets
 * exactly the behaviour of phase 5.
 */
export const telemetrySchema = Joi.object({
  // The OTLP/HTTP base URL — the exporter appends `/v1/traces` itself. An
  // empty value, as .env.example ships it, means off — not an invalid URL.
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .empty(''),

  OTEL_METRICS_EXPORTER: Joi.string()
    .valid('prometheus', 'none')
    .empty('')
    .default('none'),

  // One port per process. Six services on one host would compete for it,
  // which is why metrics are meant for the containerised stack.
  OTEL_EXPORTER_PROMETHEUS_PORT: Joi.number().port().empty('').default(9464),
});
