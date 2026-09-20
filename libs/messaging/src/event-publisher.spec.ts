import { Logger } from '@nestjs/common';
import type { ClientProxy, RmqRecord } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { DOCUMENT_EVENTS, type DocumentChunkedEvent } from '@app/common';
import { EventPublisher } from './event-publisher.js';

Logger.overrideLogger(false);

const anEvent = (): DocumentChunkedEvent => ({
  eventId: 'evt-1',
  type: DOCUMENT_EVENTS.CHUNKED,
  occurredAt: '2026-09-14T20:00:00.000Z',
  documentId: 'doc-1',
  uploadedBy: 'u-1',
  chunkCount: 3,
});

const setup = () => {
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockReturnValue(of(undefined)),
  };
  const publisher = new EventPublisher(client as unknown as ClientProxy);
  return { client, publisher };
};

describe('EventPublisher', () => {
  it('connects at boot so a bad broker URL fails the service early', async () => {
    const { client, publisher } = setup();

    await publisher.onApplicationBootstrap();

    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('emits the event under its type as pattern with the id as messageId', async () => {
    const { client, publisher } = setup();
    const event = anEvent();

    await publisher.publish(event);

    expect(client.emit).toHaveBeenCalledTimes(1);
    const [pattern, record] = client.emit.mock.calls[0] as [
      string,
      RmqRecord<DocumentChunkedEvent>,
    ];
    expect(pattern).toBe(DOCUMENT_EVENTS.CHUNKED);
    expect(record.data).toEqual(event);
    expect(record.options).toMatchObject({
      messageId: 'evt-1',
      contentType: 'application/json',
      persistent: true,
      timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
    });
  });

  it('rejects when the broker refuses the message, so the caller can record the failure', async () => {
    const { client, publisher } = setup();
    client.emit.mockReturnValue(throwError(() => new Error('channel closed')));

    await expect(publisher.publish(anEvent())).rejects.toThrow(
      'channel closed',
    );
  });

  it('resolves even though emit completes without a value', async () => {
    const { client, publisher } = setup();
    client.emit.mockReturnValue(of());

    await expect(publisher.publish(anEvent())).resolves.toBeUndefined();
  });
});
