import type { RmqContext } from '@nestjs/microservices';
import { acknowledge, deadLetter } from './consumer.js';

const setup = () => {
  const message = { content: Buffer.from('{}'), fields: {}, properties: {} };
  const channel = { ack: vi.fn(), nack: vi.fn() };
  const context = {
    getChannelRef: () => channel,
    getMessage: () => message,
  } as unknown as RmqContext;
  return { message, channel, context };
};

describe('consumer helpers', () => {
  it('acknowledge acks the delivered message on its own channel', () => {
    const { message, channel, context } = setup();

    acknowledge(context);

    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('deadLetter rejects without requeue, which is what routes to the DLX', () => {
    const { message, channel, context } = setup();

    deadLetter(context);

    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });
});
