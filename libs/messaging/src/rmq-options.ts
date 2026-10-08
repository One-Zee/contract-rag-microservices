import { type RmqOptions, Transport } from '@nestjs/microservices';
import {
  EVENTS_EXCHANGE,
  EVENTS_EXCHANGE_TYPE,
  QUEUE_OPTIONS,
  type QueueName,
} from './topology.js';

export const rmqPublisherOptions = (url: string): RmqOptions => ({
  transport: Transport.RMQ,
  options: {
    urls: [url],
    exchange: EVENTS_EXCHANGE,
    exchangeType: EVENTS_EXCHANGE_TYPE,
    wildcards: true,
    persistent: true,
  },
});

export const rmqConsumerOptions = (
  url: string,
  queue: QueueName,
): RmqOptions => ({
  transport: Transport.RMQ,
  options: {
    urls: [url],
    queue,
    queueOptions: QUEUE_OPTIONS,
    exchange: EVENTS_EXCHANGE,
    exchangeType: EVENTS_EXCHANGE_TYPE,
    wildcards: true,
    noAck: false,
    prefetchCount: 1,
  },
});
