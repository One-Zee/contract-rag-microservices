import type {
  CustomClientOptions,
  CustomStrategy,
} from '@nestjs/microservices';
import {
  InProcessClient,
  InProcessServer,
  inProcessTransportEnabled,
} from './in-process.js';
import { TracingTcpClient } from './tracing-tcp.client.js';
import { TracingTcpServer } from './tracing-tcp.server.js';

/**
 * `CustomClientOptions.customClass` is typed `Type<ClientProxy>` with the
 * default status generic (`string`), which no concrete transport client
 * satisfies — `ClientTCP` itself is `ClientProxy<TcpEvents, TcpStatus>`, and
 * the variance of its status stream rejects the assignment. The class is a
 * `ClientProxy` at runtime; only the generic parameter differs.
 */
const asClientClass = (clientClass: unknown) =>
  clientClass as CustomClientOptions['customClass'];

export interface RpcEndpoint {
  host: string;
  port: number;
}

/**
 * What a client module's `useFactory` returns instead of
 * `{ transport: Transport.TCP, options }`. Every client of another service
 * goes through here, so the transport is decided in one place — TCP between
 * processes, or in-process once the monolith has called
 * `useInProcessTransport()` (ADR 021). The endpoint is then simply unused.
 */
export function rpcClient(endpoint: RpcEndpoint): CustomClientOptions {
  return inProcessTransportEnabled()
    ? { customClass: asClientClass(InProcessClient) }
    : { customClass: asClientClass(TracingTcpClient), options: endpoint };
}

/**
 * What a service's bootstrap passes to `NestFactory.createMicroservice`
 * instead of `{ transport: Transport.TCP, options }`.
 */
export function rpcServer(endpoint: RpcEndpoint): CustomStrategy {
  return { strategy: new TracingTcpServer(endpoint) };
}

/** The monolith's counterpart of `rpcServer`: every module's handlers, served in-process. */
export function inProcessServer(): CustomStrategy {
  return { strategy: new InProcessServer() };
}
