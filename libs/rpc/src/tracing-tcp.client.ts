import {
  ClientTCP,
  type ReadPacket,
  type WritePacket,
} from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import { traceRpcCall } from './rpc-telemetry.js';
import { injectTraceContext, TRACE_CONTEXT_KEY } from './trace-context.js';

/**
 * Nest's TCP client with a CLIENT span per call and the trace context in the
 * packet envelope. Everything else — connection handling, framing, the
 * routing of replies — is `ClientTCP` unchanged.
 */
export class TracingTcpClient extends ClientTCP {
  override send<TResult = any, TInput = any>(
    pattern: any,
    data: TInput,
  ): Observable<TResult> {
    return traceRpcCall(
      this.normalizePattern(pattern),
      'nestjs_tcp',
      super.send<TResult, TInput>(pattern, data),
      { 'server.address': this.host, 'server.port': this.port },
    );
  }

  /**
   * Runs inside the subscription `traceRpcCall` opened, so the active context
   * here is the CLIENT span — the server's span becomes its child.
   */
  protected override publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => any,
  ): () => void {
    const carrier = injectTraceContext();
    const packet = carrier
      ? { ...partialPacket, [TRACE_CONTEXT_KEY]: carrier }
      : partialPacket;
    return super.publish(packet, callback);
  }
}
