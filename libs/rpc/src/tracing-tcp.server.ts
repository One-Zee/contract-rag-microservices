import { context } from '@opentelemetry/api';
import {
  type MessageHandler,
  ServerTCP,
  type TcpSocket,
} from '@nestjs/microservices';
import { traceRpcHandler } from './rpc-telemetry.js';
import { extractTraceContext } from './trace-context.js';

/**
 * Nest's TCP server that continues the caller's trace.
 *
 * `setOnProcessingStartHook` looks like the place for this, but it is handed
 * the transport and the context, never the packet — so it cannot read the
 * envelope — and the TCP server calls its end hook once per emission, not
 * once per stream. Hence two overrides: `handleMessage` sees the raw
 * packet and makes the caller's context current for everything that follows,
 * and `addHandler` wraps each request handler in a SERVER span at
 * registration. Event handlers are left alone; nothing sends events over TCP.
 */
export class TracingTcpServer extends ServerTCP {
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
            'nestjs_tcp',
            callback,
          ),
      isEventHandler,
      extras,
    );
  }

  override handleMessage(socket: TcpSocket, rawMessage: unknown): Promise<any> {
    return context.with(extractTraceContext(rawMessage), () =>
      super.handleMessage(socket, rawMessage),
    );
  }
}
