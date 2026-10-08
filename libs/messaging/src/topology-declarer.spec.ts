import amqplib from 'amqplib';
import { declareTopologyAt } from './topology-declarer.js';

vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));

const connect = vi.mocked(amqplib.connect);
const URL_WITH_SECRET = 'amqp://app:s3cret-pass@broker.internal:5672/vhost';

const connectionMock = () => {
  const channel = {
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    bindQueue: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const connection = {
    createChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { connection, channel };
};

beforeEach(() => {
  connect.mockReset();
});

describe('declareTopologyAt', () => {
  it('retries a broker that is still starting, then declares and disconnects', async () => {
    const { connection, channel } = connectionMock();
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(connection as never);

    await declareTopologyAt(URL_WITH_SECRET, {
      timeoutMs: 1_000,
      retryDelayMs: 1,
    });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(channel.assertExchange).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout with a message that omits the credentials', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5672'));

    const attempt = declareTopologyAt(URL_WITH_SECRET, {
      timeoutMs: 20,
      retryDelayMs: 5,
    });

    await expect(attempt).rejects.toThrow(/broker\.internal:5672 unreachable/);
    await expect(attempt).rejects.not.toThrow(/s3cret/);
    await expect(attempt).rejects.toThrow(/ECONNREFUSED/);
  });

  it('does not retry a declaration the broker rejected (406 on mismatched queue arguments)', async () => {
    const { connection, channel } = connectionMock();
    channel.assertQueue.mockRejectedValue(
      new Error('PRECONDITION_FAILED - inequivalent arg'),
    );
    connect.mockResolvedValue(connection as never);

    await expect(
      declareTopologyAt(URL_WITH_SECRET, { timeoutMs: 1_000, retryDelayMs: 1 }),
    ).rejects.toThrow('PRECONDITION_FAILED');

    expect(connect).toHaveBeenCalledTimes(1);
    // The connection is released even though the declaration failed.
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
