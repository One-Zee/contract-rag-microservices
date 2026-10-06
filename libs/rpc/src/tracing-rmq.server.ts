import { context, propagation, trace } from '@opentelemetry/api';
import { type MessageHandler, ServerRMQ } from '@nestjs/microservices';
import { traceRpcHandler } from './rpc-telemetry.js';
import type { TraceCarrier } from './trace-context.js';

interface AmqpMessage {
  properties?: { headers?: TraceCarrier };
}

/**
 * Nest's RabbitMQ server that continues the caller's trace — the RMQ twin of
 * `TracingTcpServer`, with the context read from the message headers.
 *
 * When the amqplib instrumentation is on, the consume callback already runs
 * inside its CONSUMER span, a descendant of the caller's; that span is kept
 * as the parent so the waterfall shows the hop through the broker.
 */
export class TracingRmqServer extends ServerRMQ {
  override addHandler(
    pattern: any,
    callback: MessageHandler,
    isEventHandler = false,
    extras: Record<string, any> = {},
  ): void {
    super.addHandler(
      pattern,
      isEventHandler
        ? callback
        : traceRpcHandler(
            this.normalizePattern(pattern),
            'nestjs_rmq',
            callback,
          ),
      isEventHandler,
      extras,
    );
  }

  override handleMessage(
    message: Record<string, any>,
    channel: any,
  ): Promise<void> {
    const active = context.active();
    const headers = (message as AmqpMessage | null)?.properties?.headers;
    const parent =
      trace.getSpan(active) || !headers
        ? active
        : propagation.extract(active, headers);
    return context.with(parent, () => super.handleMessage(message, channel));
  }
}
