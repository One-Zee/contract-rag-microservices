import { type Context, context, propagation } from '@opentelemetry/api';

/**
 * Where the W3C trace context travels in a TCP packet: in the envelope, next
 * to `pattern`, `data` and `id` — never inside `data`.
 *
 * Nest's TCP transport has no headers, so the envelope is the only place that
 * is not someone's payload. Kept out of `data`, the message contracts in
 * `libs/common` stay exactly as they are, the handler never sees the field,
 * and the change is compatible in both directions: a plain `ServerTCP`
 * ignores an extra envelope key, and `TracingTcpServer` handles a packet
 * without one as the start of a new trace .
 */
export const TRACE_CONTEXT_KEY = 'traceContext';

export type TraceCarrier = Record<string, string>;

/** `undefined` when there is nothing to propagate — no SDK, or no active span. */
export function injectTraceContext(): TraceCarrier | undefined {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

export function extractTraceContext(packet: unknown): Context {
  const carrier =
    typeof packet === 'object' && packet !== null
      ? (packet as Record<string, unknown>)[TRACE_CONTEXT_KEY]
      : undefined;
  if (typeof carrier !== 'object' || carrier === null) return context.active();
  return propagation.extract(context.active(), carrier as TraceCarrier);
}
