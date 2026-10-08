import type {
  CustomClientOptions,
  CustomStrategy,
  RmqOptions,
} from '@nestjs/microservices';
import {
  InProcessClient,
  InProcessServer,
  inProcessTransportEnabled,
} from './in-process.js';
import { TracingRmqClient } from './tracing-rmq.client.js';
import { TracingRmqServer } from './tracing-rmq.server.js';
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

/** What `AppConfigService.rpcEndpoint()` returns, for either transport. */
export interface RpcEndpoint {
  /** The service; over RabbitMQ its queue is `clauseiq.rpc.<name>`. */
  name: string;
  host: string;
  port: number;
  transport: 'tcp' | 'rmq';
  /** Set whenever `transport` is `rmq`. */
  rabbitmqUrl?: string;
}

/**
 * Request queues are not durable and messages not persistent: a request
 * outlives neither the broker nor the caller's patience, the same contract
 * a TCP connection gives. Both sides must declare the queue identically, or
 * the second declaration fails with 406 at boot.
 */
function rmqOptions(endpoint: RpcEndpoint): Required<RmqOptions>['options'] {
  if (!endpoint.rabbitmqUrl) {
    throw new Error(`RPC over RabbitMQ needs RABBITMQ_URL (${endpoint.name})`);
  }
  return {
    urls: [endpoint.rabbitmqUrl],
    queue: `clauseiq.rpc.${endpoint.name}`,
    queueOptions: { durable: false },
    persistent: false,
  };
}

/**
 * What a client module's `useFactory` returns. Every client of another
 * service goes through here, so the transport is decided in one place — TCP
 * or RabbitMQ between processes (`RPC_TRANSPORT`), or in-process once the
 * monolith has called `useInProcessTransport()`.
 */
export function rpcClient(endpoint: RpcEndpoint): CustomClientOptions {
  if (inProcessTransportEnabled()) {
    return { customClass: asClientClass(InProcessClient) };
  }
  return endpoint.transport === 'rmq'
    ? {
        customClass: asClientClass(TracingRmqClient),
        options: rmqOptions(endpoint),
      }
    : {
        customClass: asClientClass(TracingTcpClient),
        options: { host: endpoint.host, port: endpoint.port },
      };
}

/** What a service's bootstrap passes to `NestFactory.createMicroservice`. */
export function rpcServer(endpoint: RpcEndpoint): CustomStrategy {
  return {
    strategy:
      endpoint.transport === 'rmq'
        ? new TracingRmqServer(rmqOptions(endpoint))
        : new TracingTcpServer({ host: endpoint.host, port: endpoint.port }),
  };
}

/** For the bootstrap's log line: where the server is reachable. */
export const rpcAddress = (endpoint: RpcEndpoint): string =>
  endpoint.transport === 'rmq'
    ? `rabbitmq queue clauseiq.rpc.${endpoint.name}`
    : `tcp://${endpoint.host}:${endpoint.port}`;

/** The monolith's counterpart of `rpcServer`: every module's handlers, served in-process. */
export function inProcessServer(): CustomStrategy {
  return { strategy: new InProcessServer() };
}
