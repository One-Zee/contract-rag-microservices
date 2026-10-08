import type { MessageHandler } from '@nestjs/microservices';
import {
  type Attributes,
  type Context,
  context,
  type Histogram,
  metrics,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { isObservable, Observable, of } from 'rxjs';

/**
 * `nestjs_tcp` or `nestjs_rmq` between processes, `in_process` inside the
 * monolith. The same pattern measured under each value is what §9.5 calls
 * the cost of the transport abstraction.
 */
export type RpcSystem = 'nestjs_tcp' | 'nestjs_rmq' | 'in_process';

/**
 * `rejected` is a 4xx from the other side — the caller's mistake, not a
 * failure of the hop — so it does not mark the span as an error.
 */
type Outcome = 'ok' | 'rejected' | 'error' | 'cancelled';

const SCOPE = '@app/rpc';
const OUTCOME = 'clauseiq.rpc.outcome';

// Wide enough for a streamed answer: `llm.query` lasts as long as the model
// writes, and the default buckets stop at ten seconds.
const DURATION_BUCKETS_MS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 20_000, 30_000,
  60_000,
];

// Created on first use rather than at import: a meter obtained before the SDK
// starts stays a no-op for good.
let clientDuration: Histogram | undefined;
let serverDuration: Histogram | undefined;

const histogram = (name: string, description: string): Histogram =>
  metrics.getMeter(SCOPE).createHistogram(name, {
    unit: 'ms',
    description,
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS },
  });

const clientHistogram = () =>
  (clientDuration ??= histogram(
    'rpc.client.duration',
    'Duration of an RPC as seen by the caller, until the last emission',
  ));

const serverHistogram = () =>
  (serverDuration ??= histogram(
    'rpc.server.duration',
    'Duration of an RPC as seen by the handler, guards included',
  ));

/**
 * Reads the `RpcErrorShape` contract from `@app/common` by duck typing, so
 * this library does not depend on it.
 */
function classify(error: unknown): { outcome: Outcome; message: string } {
  if (typeof error === 'object' && error !== null) {
    const { statusCode, message } = error as {
      statusCode?: unknown;
      message?: unknown;
    };
    const text = typeof message === 'string' ? message : 'RPC error';
    return typeof statusCode === 'number' && statusCode < 500
      ? { outcome: 'rejected', message: text }
      : { outcome: 'error', message: text };
  }
  return { outcome: 'error', message: String(error) };
}

class RpcSpan {
  readonly activeContext: Context;
  private readonly started = performance.now();
  private settled = false;

  constructor(
    private readonly span: Span,
    private readonly duration: () => Histogram,
    private readonly attributes: Attributes,
  ) {
    this.activeContext = trace.setSpan(context.active(), span);
  }

  finish(outcome: Outcome, message?: string): void {
    if (this.settled) return;
    this.settled = true;
    this.span.setAttribute(OUTCOME, outcome);
    if (outcome === 'error') {
      this.span.setStatus({ code: SpanStatusCode.ERROR, message });
    }
    this.span.end();
    this.duration().record(performance.now() - this.started, {
      ...this.attributes,
      [OUTCOME]: outcome,
    });
  }

  fail(error: unknown): void {
    const { outcome, message } = classify(error);
    this.finish(outcome, message);
  }

  /**
   * Subscribes inside the span's context, so whatever the subscription sets
   * off — including work an async generator does long after the handler
   * returned — sees this span as its parent. Ends with the stream.
   *
   * A consumer that leaves after a value got its answer: `firstValueFrom`
   * unsubscribes inside the first `next`, before the completion is delivered.
   * Only leaving before any value counts as a cancellation.
   */
  wrap<T>(source$: Observable<T>): Observable<T> {
    return new Observable<T>((subscriber) => {
      let received = false;
      const subscription = context.with(this.activeContext, () =>
        source$.subscribe({
          next: (value) => {
            received = true;
            subscriber.next(value);
          },
          error: (error: unknown) => {
            this.fail(error);
            subscriber.error(error);
          },
          complete: () => {
            this.finish('ok');
            subscriber.complete();
          },
        }),
      );
      return () => {
        subscription.unsubscribe();
        this.finish(received ? 'ok' : 'cancelled');
      };
    });
  }
}

const rpcAttributes = (method: string, system: RpcSystem): Attributes => ({
  'rpc.system': system,
  'rpc.method': method,
});

/**
 * The caller's side of an RPC: a CLIENT span from subscription to the last
 * emission. The subscription is cold, so the span starts when someone
 * actually subscribes, not when `send()` is called.
 */
export function traceRpcCall<T>(
  method: string,
  system: RpcSystem,
  source$: Observable<T>,
  extra: Attributes = {},
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const attributes = rpcAttributes(method, system);
    const span = trace.getTracer(SCOPE).startSpan(method, {
      kind: SpanKind.CLIENT,
      attributes: { ...attributes, ...extra },
    });
    return new RpcSpan(span, clientHistogram, attributes)
      .wrap(source$)
      .subscribe(subscriber);
  });
}

/**
 * The handler's side: a SERVER span around the handler Nest registered —
 * guards, pipes and the exception filter included — and around the stream it
 * returns, which for `llm.query` is where nearly all of the time is spent.
 */
export function traceRpcHandler(
  method: string,
  system: RpcSystem,
  handler: MessageHandler,
): MessageHandler {
  return async (data: unknown, ctx?: unknown) => {
    const attributes = rpcAttributes(method, system);
    const span = trace.getTracer(SCOPE).startSpan(method, {
      kind: SpanKind.SERVER,
      attributes,
    });
    const rpcSpan = new RpcSpan(span, serverHistogram, attributes);
    let result: unknown;
    try {
      result = await context.with(rpcSpan.activeContext, () =>
        handler(data, ctx),
      );
    } catch (error) {
      rpcSpan.fail(error);
      throw error;
    }
    return rpcSpan.wrap(isObservable(result) ? result : of(result));
  };
}
