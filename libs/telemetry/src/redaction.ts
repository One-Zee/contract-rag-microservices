import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

export const REDACTED = '[REDACTED]';

/**
 * Attribute keys are matched case-insensitively against these fragments, and
 * a match replaces the whole value. Every entry answers a named obligation:
 *
 * - `accesstoken` / `access_token` — the field every protected RPC payload
 *   carries ;
 * - `contentbase64` — the uploaded contract itself, inside the upload payload
 * - `authorization`, `x-api-key` — the Voyage and Cohere bearer keys and
 *   Anthropic's key header on outgoing calls (ADR 012, 015, 016);
 * - `question`, `prompt`, `gen_ai.input`, `gen_ai.output`, `gen_ai.prompt`,
 *   `gen_ai.completion` — a question about a contract quotes the contract, and
 *   so does the prompt built around it (ADR 016);
 * - `cookie`, `password`, `secret` — never wanted in a trace, whatever adds them.
 *
 * None of the configured instrumentations records these today, and no manual
 * span may put a payload into an attribute. This list is what still holds if
 * either of those ever stops being true.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'accesstoken',
  'access_token',
  'contentbase64',
  'authorization',
  'x-api-key',
  'question',
  'prompt',
  'gen_ai.input',
  'gen_ai.output',
  'gen_ai.completion',
  'cookie',
  'password',
  'secret',
];

/**
 * Attributes holding a whole URL keep the path and lose the query string:
 * `GET /search?q=…` carries the question in it.
 */
const URL_KEYS = new Set([
  'url.full',
  'url.original',
  'http.url',
  'http.target',
]);

/** Holds nothing but the query string. */
const QUERY_KEYS = new Set(['url.query']);

/** header.payload.signature — an access token wherever it turns up, error messages included. */
const JWT_PATTERN = /eyJ[\w-]*\.[\w-]+\.[\w-]*/g;

const scrub = (value: string): string => value.replace(JWT_PATTERN, REDACTED);

const stripQuery = (url: string): string => {
  const start = url.indexOf('?');
  return start === -1 ? url : `${url.slice(0, start)}?${REDACTED}`;
};

function redactValue(key: string, value: AttributeValue): AttributeValue {
  const lower = key.toLowerCase();
  if (
    QUERY_KEYS.has(lower) ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))
  ) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return URL_KEYS.has(lower) ? stripQuery(scrub(value)) : scrub(value);
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) =>
      typeof item === 'string' ? scrub(item) : item,
    ) as AttributeValue;
  }
  return value;
}

export function redactAttributes(attributes: Attributes): Attributes {
  const redacted: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    redacted[key] = value === undefined ? value : redactValue(key, value);
  }
  return redacted;
}

/**
 * A copy of the span with attributes, event and link attributes and the
 * status message redacted. Built field by field against `ReadableSpan` so the
 * compiler names anything a future SDK version adds.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const { status } = span;
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status:
      status.message === undefined
        ? status
        : { ...status, message: scrub(status.message) },
    attributes: redactAttributes(span.attributes),
    links: span.links.map((link) =>
      link.attributes
        ? { ...link, attributes: redactAttributes(link.attributes) }
        : link,
    ),
    events: span.events.map((event) =>
      event.attributes
        ? { ...event, attributes: redactAttributes(event.attributes) }
        : event,
    ),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * The only exporter `startTelemetry` ever configures, wrapped around the OTLP
 * one — so "redaction is in place before the first span is exported" is true
 * by construction rather than by remembering (ADR 006, 019).
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
