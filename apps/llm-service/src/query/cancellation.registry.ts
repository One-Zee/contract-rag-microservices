import { Injectable, Logger } from '@nestjs/common';

/**
 * The in-flight generations this process can still stop.
 *
 * It exists because Nest's TCP transport carries no cancellation. Unsubscribing
 * from a `ClientProxy.send()` runs a teardown that deletes a local routing
 * entry (`ClientTCP.publish` returns `() => this.routingMap.delete(id)`) and
 * sends the server nothing at all: the handler keeps running, the model keeps
 * generating, and the tokens keep being billed for an answer nobody is reading.
 *
 * So what an unsubscribe cannot say is said as a message instead —
 * `LLM_PATTERNS.CANCEL`, keyed by the query id the client received in its
 * `meta` event. That is the concrete cost of the transport abstraction, and
 * the shape of the workaround is the point (plan §9.5), not an implementation
 * detail.
 *
 * Process-local on purpose: with several llm-service instances behind a load
 * balancer the cancel would have to reach the instance that is generating,
 * which needs a shared bus. Named as a limitation rather than solved — the
 * thesis runs one instance per service.
 */
@Injectable()
export class QueryCancellationRegistry {
  private readonly logger = new Logger(QueryCancellationRegistry.name);
  private readonly inFlight = new Map<string, AbortController>();

  /** Returns the signal to hand the provider; always pair with `release`. */
  register(queryId: string): AbortSignal {
    const controller = new AbortController();
    this.inFlight.set(queryId, controller);
    return controller.signal;
  }

  /** `false` when the query already finished — a cancel that arrived too late. */
  cancel(queryId: string): boolean {
    const controller = this.inFlight.get(queryId);
    if (!controller) {
      return false;
    }
    this.inFlight.delete(queryId);
    controller.abort(new Error('Cancelled by the client'));
    this.logger.debug(`Cancelled query ${queryId}`);
    return true;
  }

  /** Always call in a `finally`; a leaked entry holds an AbortController forever. */
  release(queryId: string): void {
    this.inFlight.delete(queryId);
  }

  /** Whether this query is still generating — used to classify how it ended. */
  has(queryId: string): boolean {
    return this.inFlight.has(queryId);
  }
}
