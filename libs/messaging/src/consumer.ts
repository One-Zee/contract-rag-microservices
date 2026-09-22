import type { RmqContext } from '@nestjs/microservices';
import type { Channel, ConsumeMessage } from 'amqplib';

/**
 * Manual acknowledgement for `@EventPattern` handlers on queues consumed with
 * `noAck: false` (`rmqConsumerOptions`).
 *
 * Nest does neither for an event: a handler that throws is logged by the RPC
 * exception filter and its message stays unacknowledged until the channel
 * closes, when the broker redelivers it — a crash loop for a poison message.
 * So a handler decides one of these for every outcome and never lets an
 * exception escape.
 */

/** The broker forgets the message: it was handled, or there is nothing left to do with it. */
export const acknowledge = (context: RmqContext): void => {
  const channel = context.getChannelRef() as Channel;
  channel.ack(context.getMessage() as ConsumeMessage);
};

/**
 * `nack` with `requeue: false`: the message leaves this queue for the
 * dead-letter exchange in `QUEUE_OPTIONS` and lands in `clauseiq.events.dlq`,
 * where an operator can inspect and replay it. `requeue: true` would put it
 * straight back at the head of the queue — a hot loop while the cause (a
 * provider outage, a database that is down) is still there.
 */
export const deadLetter = (context: RmqContext): void => {
  const channel = context.getChannelRef() as Channel;
  channel.nack(context.getMessage() as ConsumeMessage, false, false);
};
