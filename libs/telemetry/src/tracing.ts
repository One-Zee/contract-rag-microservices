import {
  context,
  metrics,
  type Attributes,
  type Meter,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';

const SCOPE = 'clauseiq';

/**
 * Ask for these where an instrument is created — in a provider's constructor,
 * never at module scope. A tracer obtained early is a proxy and recovers once
 * the SDK registers, but a meter obtained before `startTelemetry` stays a
 * no-op for good, and its instruments with it.
 */
export const getTracer = (): Tracer => trace.getTracer(SCOPE);
export const getMeter = (): Meter => metrics.getMeter(SCOPE);

/**
 * Runs `work` inside an active span named `name`, so anything it calls —
 * a query, a fetch, an RPC — becomes a child. Records a thrown error and
 * rethrows it; the span always ends.
 *
 * Attributes describe the work (counts, sizes, modes), never its content: the
 * question, the prompt and contract text must not reach a span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T> | T,
): Promise<T> {
  return getTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      const exception = error instanceof Error ? error : String(error);
      span.recordException(exception);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Iterates `source` with `span` active, so whatever each step does — the
 * request to the model, above all — becomes a child of the span.
 *
 * For a consumer that yields between steps, which `withSpan` cannot wrap: a
 * `yield` inside its callback would suspend the generator with the span still
 * open in someone else's context. Early exit is passed through, so a consumer
 * that stops iterating still lets the source clean up.
 */
export function iterateInSpan<T>(
  span: Span,
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  const active = trace.setSpan(context.active(), span);
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      const iterator = context.with(active, () =>
        source[Symbol.asyncIterator](),
      );
      return {
        next: () => context.with(active, () => iterator.next()),
        return: (value?: unknown) =>
          context.with(active, () =>
            iterator.return
              ? iterator.return(value)
              : Promise.resolve({ done: true as const, value: value as T }),
          ),
      };
    },
  };
}
