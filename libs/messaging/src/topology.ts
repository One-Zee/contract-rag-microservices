import type { Channel, Options } from 'amqplib';
import { DOCUMENT_EVENTS } from '@app/common';

export const EVENTS_EXCHANGE = 'clauseiq.events';
export const EVENTS_EXCHANGE_TYPE = 'topic';

export const DEAD_LETTER_EXCHANGE = 'clauseiq.events.dlx';
export const DEAD_LETTER_QUEUE = 'clauseiq.events.dlq';

/** One queue per consuming service. */
export const QUEUES = {
  INDEXING: 'indexing',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Which events each queue receives — the routing keys it is bound with. */
export const QUEUE_BINDINGS: Readonly<Record<QueueName, readonly string[]>> = {
  [QUEUES.INDEXING]: [DOCUMENT_EVENTS.CHUNKED],
};

/**
 * Applied to every consumer queue. RabbitMQ rejects a later `assertQueue` with
 * different arguments (406 PRECONDITION_FAILED), which is why the dead-letter
 * argument is here from the first declaration and why `rmqConsumerOptions`
 * reuses this object instead of spelling its own.
 */
export const QUEUE_OPTIONS: Options.AssertQueue = {
  durable: true,
  arguments: { 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE },
};

/** The subset of an amqplib channel the declaration needs — mockable in tests. */
export type TopologyChannel = Pick<
  Channel,
  'assertExchange' | 'assertQueue' | 'bindQueue'
>;

export async function declareTopology(channel: TopologyChannel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, EVENTS_EXCHANGE_TYPE, {
    durable: true,
  });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {
    durable: true,
  });
  await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, '');

  for (const [queue, routingKeys] of Object.entries(QUEUE_BINDINGS)) {
    await channel.assertQueue(queue, QUEUE_OPTIONS);
    for (const routingKey of routingKeys) {
      await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
    }
  }
}
