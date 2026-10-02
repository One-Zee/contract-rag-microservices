import type { IncomingMessage } from 'node:http';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import {
  ExpressInstrumentation,
  ExpressLayerType,
} from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

/**
 * Requests that would only add noise: Docker polls `/health` every few
 * seconds, Prometheus scrapes `/metrics` every five, and the Swagger UI is a
 * page of static assets.
 */
const isNoise = (request: IncomingMessage): boolean => {
  const path = request.url?.split('?')[0] ?? '';
  return (
    path === '/health' || path === '/metrics' || path.startsWith('/api/docs')
  );
};

/**
 * An explicit list rather than `auto-instrumentations-node` (ADR 019). Every
 * entry is here because a span or a metric from it answers a question the
 * thesis asks; everything else (fs, dns, net, …) would bury those spans.
 *
 * Deliberately absent: `@opentelemetry/instrumentation-nestjs-core`. Its
 * supported range is `>=4.0.0 <12` and this repository runs Nest 12, so it
 * would load and do nothing. The RPC spans come from `@app/rpc` instead.
 */
export function createInstrumentations() {
  return [
    // The gateway's incoming requests and every outgoing call made through
    // `node:http` (the OTLP exporter's own requests are suppressed by the SDK).
    new HttpInstrumentation({ ignoreIncomingRequestHook: isNoise }),

    // Gives the HTTP span its route (`POST /query`, not just `POST`). Without
    // the middleware layers — body parsing and multer are not what a reader of
    // the waterfall is looking for.
    new ExpressInstrumentation({
      ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
    }),

    // `requireParentSpan`: pool connects and the boot sweeps would otherwise
    // each open a trace of their own. `enhancedDatabaseReporting` stays off —
    // it records bound parameter values, and those are questions and contract
    // text (ADR 016).
    new PgInstrumentation({
      requireParentSpan: true,
      enhancedDatabaseReporting: false,
    }),

    // Puts the trace context into the AMQP headers on publish and resumes it
    // on consume, so an upload and its indexing are one trace.
    new AmqplibInstrumentation(),

    // Global `fetch` — Voyage, Cohere, Anthropic and Ollama. Request headers
    // are not recorded unless configured, and they are not configured here.
    new UndiciInstrumentation(),

    // The S3 calls to MinIO; the SDK's internal HTTP span is redundant with it.
    new AwsInstrumentation({ suppressInternalInstrumentation: true }),

    // Event-loop delay and heap per process — metrics only.
    new RuntimeNodeInstrumentation(),
  ];
}
