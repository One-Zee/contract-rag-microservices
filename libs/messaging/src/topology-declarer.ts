import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import amqplib from 'amqplib';
import { AppConfigService } from '@app/config';
import {
  declareTopology,
  EVENTS_EXCHANGE,
  QUEUE_BINDINGS,
} from './topology.js';

export interface DeclareTopologyOptions {
  /** How long to keep retrying an unreachable broker before giving up. */
  timeoutMs?: number;
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** `amqp://user:secret@host:5672` → `host:5672` — credentials never reach a log line. */
const describe = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid RABBITMQ_URL>';
  }
};

/**
 * Connects, declares the topology, disconnects. A broker that is not up yet
 * (`npm run dev` starts it in parallel with the services) is retried until
 * `timeoutMs`; a broker that *rejects* the declaration — typically 406 because
 * a queue already exists with different arguments — fails immediately, since
 * no amount of retrying changes that answer.
 */
export async function declareTopologyAt(
  url: string,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  }: DeclareTopologyOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let connection;
    try {
      connection = await amqplib.connect(url);
    } catch (error) {
      if (Date.now() + retryDelayMs >= deadline) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `RabbitMQ at ${describe(url)} unreachable for ${timeoutMs} ms: ${reason}`,
          { cause: error },
        );
      }
      await sleep(retryDelayMs);
      continue;
    }

    try {
      const channel = await connection.createChannel();
      await declareTopology(channel);
      await channel.close();
      return;
    } finally {
      await connection.close().catch(() => undefined);
    }
  }
}

@Injectable()
export class TopologyDeclarer implements OnModuleInit {
  private readonly logger = new Logger(TopologyDeclarer.name);

  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    await declareTopologyAt(this.config.rabbitmqUrl);
    this.logger.log(
      `RabbitMQ topology declared (exchange ${EVENTS_EXCHANGE}, queues: ${Object.keys(QUEUE_BINDINGS).join(', ')})`,
    );
  }
}
