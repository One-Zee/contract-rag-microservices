import {
  BaseRpcContext,
  ClientProxy,
  type CustomTransportStrategy,
  type MessageHandler,
  type ReadPacket,
  Server,
  type WritePacket,
} from '@nestjs/microservices';
import { defer, isObservable, mergeMap, type Observable, of } from 'rxjs';
import { traceRpcCall, traceRpcHandler } from './rpc-telemetry.js';

/**
 * The monolith's transport : a client that calls the handler Nest
 * registered for a pattern, in the same process, instead of writing a packet
 * to a socket.
 *
 * What stays the same as over TCP is everything Nest wraps around a handler:
 * guards (`RpcAuthGuard` still verifies the forwarded token), pipes, and the
 * exception filter that turns an `RpcException` into the error shape the
 * gateway's `rpcToHttp` maps. What disappears is the network hop and the JSON
 * round trip — the payload is passed by reference, a 10 MB upload included —
 * and the gap between a client's and a server's span. That difference is
 * what comparing the two topologies measures.
 */

let inProcess = false;

/** The process's one in-process server, once it is listening. */
const registry: { server?: InProcessServer } = {};

/**
 * Called by the monolith before its modules are created: every client module
 * asks `rpcClient()` which transport to build, and the answer is decided here.
 */
export function useInProcessTransport(): void {
  inProcess = true;
}

export function inProcessTransportEnabled(): boolean {
  return inProcess;
}

/** What a handler receives where one behind TCP would get a `TcpContext`. */
export class InProcessContext extends BaseRpcContext<[pattern: string]> {
  getPattern(): string {
    return this.args[0];
  }
}

/**
 * Holds the request handlers of every module in the process. Event handlers
 * are not served here: `document.chunked` still travels over RabbitMQ in the
 * monolith, because indexing settles each message by hand on its `RmqContext`.
 */
export class InProcessServer extends Server implements CustomTransportStrategy {
  override readonly transportId = Symbol('in-process');

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
            'in_process',
            callback,
          ),
      isEventHandler,
      extras,
    );
  }

  listen(callback: () => void): void {
    registry.server = this;
    callback();
  }

  close(): void {
    if (registry.server === this) registry.server = undefined;
  }

  /** No connection, so no transport events to subscribe to. */
  on(): void {}

  unwrap<T>(): T {
    throw new Error('The in-process transport has no underlying server');
  }

  /** The handler Nest registered for `pattern`, guards and filter included. */
  handlerFor(pattern: string): MessageHandler | null {
    return this.getHandlerByPattern(pattern);
  }
}

export class InProcessClient extends ClientProxy {
  async connect(): Promise<void> {}

  close(): void {}

  unwrap<T>(): T {
    throw new Error('The in-process transport has no underlying connection');
  }

  override send<TResult = any, TInput = any>(
    pattern: any,
    data: TInput,
  ): Observable<TResult> {
    return traceRpcCall(
      this.normalizePattern(pattern),
      'in_process',
      super.send<TResult, TInput>(pattern, data),
    );
  }

  /**
   * Runs the handler and relays its stream. The teardown unsubscribes from
   * it, so — unlike over TCP — stopping the caller stops the handler too.
   */
  protected publish(
    packet: ReadPacket,
    callback: (packet: WritePacket) => void,
  ): () => void {
    const pattern = this.normalizePattern(packet.pattern);
    const server = registry.server;
    const handler = server?.handlerFor(pattern);
    if (!server || !handler) {
      // What a TCP server answers for a pattern nobody handles.
      callback({
        err: `There is no in-process handler for "${pattern}"`,
        isDisposed: true,
      });
      return () => undefined;
    }
    const response$ = defer(() =>
      handler(packet.data, new InProcessContext([pattern])),
    ).pipe(mergeMap((result) => (isObservable(result) ? result : of(result))));
    // Nest's own reply logic, the one `ServerTCP` uses: it folds the
    // completion into the last value, so a one-value reply is a single
    // packet here as it is over TCP. Without it a caller that takes the first
    // value and leaves (`firstValueFrom`) would look like a cancellation.
    const subscription = server.send(response$, (reply) => callback(reply));
    return () => subscription.unsubscribe();
  }

  protected dispatchEvent<T = any>(): Promise<T> {
    return Promise.reject(
      new Error('Events travel over RabbitMQ in the monolith too'),
    );
  }
}
