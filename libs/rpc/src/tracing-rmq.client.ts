import { ClientRMQ } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import { traceRpcCall } from './rpc-telemetry.js';
import { injectTraceContext } from './trace-context.js';

/**
 * Nest's RabbitMQ client with a CLIENT span per call. Unlike TCP, AMQP has
 * headers, so the trace context travels there instead of in the envelope.
 *
 * Replies come back on `amq.rabbitmq.reply-to` (direct reply-to, no queue to
 * declare), routed by correlation id; a streamed handler sends one message
 * per emission and Nest's client keeps the route open until the last one —
 * which is what lets `llm.query` stream over this transport unchanged.
 */
export class TracingRmqClient extends ClientRMQ {
  override send<TResult = any, TInput = any>(
    pattern: any,
    data: TInput,
  ): Observable<TResult> {
    return traceRpcCall(
      this.normalizePattern(pattern),
      'nestjs_rmq',
      super.send<TResult, TInput>(pattern, data),
      { 'messaging.destination.name': this.queue },
    );
  }

  /** Called while publishing, inside the CLIENT span `traceRpcCall` opened. */
  protected override mergeHeaders(
    requestHeaders?: Record<string, string>,
  ): Record<string, string> | undefined {
    const carrier = injectTraceContext();
    const headers = super.mergeHeaders(requestHeaders);
    return carrier ? { ...headers, ...carrier } : headers;
  }
}
