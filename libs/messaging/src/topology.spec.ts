import { Transport } from '@nestjs/microservices';
import { DOCUMENT_EVENTS } from '@app/common';
import { rmqConsumerOptions, rmqPublisherOptions } from './rmq-options.js';
import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE,
  declareTopology,
  EVENTS_EXCHANGE,
  QUEUE_OPTIONS,
  QUEUES,
  type TopologyChannel,
} from './topology.js';

const channelMock = () => ({
  assertExchange: vi.fn().mockResolvedValue(undefined),
  assertQueue: vi.fn().mockResolvedValue(undefined),
  bindQueue: vi.fn().mockResolvedValue(undefined),
});

describe('declareTopology', () => {
  it('declares a durable topic exchange for events', async () => {
    const channel = channelMock();

    await declareTopology(channel as unknown as TopologyChannel);

    expect(channel.assertExchange).toHaveBeenCalledWith(
      EVENTS_EXCHANGE,
      'topic',
      { durable: true },
    );
  });

  it('routes document.chunked into the indexing queue', async () => {
    const channel = channelMock();

    await declareTopology(channel as unknown as TopologyChannel);

    expect(channel.assertQueue).toHaveBeenCalledWith(
      QUEUES.INDEXING,
      QUEUE_OPTIONS,
    );
    expect(channel.bindQueue).toHaveBeenCalledWith(
      QUEUES.INDEXING,
      EVENTS_EXCHANGE,
      DOCUMENT_EVENTS.CHUNKED,
    );
  });

  it('dead-letters every consumer queue into one durable queue', async () => {
    const channel = channelMock();

    await declareTopology(channel as unknown as TopologyChannel);

    expect(QUEUE_OPTIONS.arguments['x-dead-letter-exchange']).toBe(
      DEAD_LETTER_EXCHANGE,
    );
    expect(channel.assertExchange).toHaveBeenCalledWith(
      DEAD_LETTER_EXCHANGE,
      'fanout',
      { durable: true },
    );
    expect(channel.assertQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE, {
      durable: true,
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      DEAD_LETTER_QUEUE,
      DEAD_LETTER_EXCHANGE,
      '',
    );
  });

  it('is idempotent — asserts and binds, never deletes', async () => {
    const channel = channelMock();

    await declareTopology(channel as unknown as TopologyChannel);
    await declareTopology(channel as unknown as TopologyChannel);

    expect(channel.assertQueue).toHaveBeenCalledTimes(4);
    expect(Object.keys(channel)).not.toContain('deleteQueue');
  });
});

describe('rmq options', () => {
  const url = 'amqp://guest:guest@localhost:5672';

  it('publisher targets the topic exchange with the pattern as routing key', () => {
    const { transport, options } = rmqPublisherOptions(url);

    expect(transport).toBe(Transport.RMQ);
    expect(options).toMatchObject({
      urls: [url],
      exchange: EVENTS_EXCHANGE,
      exchangeType: 'topic',
      wildcards: true,
      persistent: true,
    });
    // A publisher owns no queue — in wildcards mode Nest would otherwise
    // assert one named after the default and leave it dangling.
    expect(options).not.toHaveProperty('queue');
  });

  it('consumer asserts its queue with the exact options the topology used', () => {
    const { options } = rmqConsumerOptions(url, QUEUES.INDEXING);

    expect(options?.queue).toBe(QUEUES.INDEXING);
    // Same object, not a look-alike: a mismatch is a 406 at boot.
    expect(options?.queueOptions).toBe(QUEUE_OPTIONS);
    expect(options).toMatchObject({
      exchange: EVENTS_EXCHANGE,
      wildcards: true,
      noAck: false,
      prefetchCount: 1,
    });
  });
});
