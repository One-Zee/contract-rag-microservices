import {
  HttpException,
  Logger,
  RequestMethod,
  type MessageEvent,
} from '@nestjs/common';
import { METHOD_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import type { ClientProxy } from '@nestjs/microservices';
import { NEVER, concat, lastValueFrom, of, throwError, toArray } from 'rxjs';
import type { QueryStreamEvent } from '@app/common';
import { QueryController } from './query.controller.js';

// The 503 case logs the transport failure it is asserting on.
Logger.overrideLogger(false);

const meta: QueryStreamEvent = {
  type: 'meta',
  data: {
    queryId: 'q-1',
    question: 'How much notice?',
    mode: 'hybrid',
    model: 'fake-legal-assistant',
    sources: [],
  },
};

const token: QueryStreamEvent = { type: 'token', data: { text: 'Ninety' } };

const neverAborts = new AbortController().signal;

const body = {
  question: 'How much notice?',
  mode: 'hybrid' as const,
};

const setup = (stream: ReturnType<ClientProxy['send']>) => {
  const send = vi.fn().mockReturnValue(stream);
  return {
    controller: new QueryController({ send } as unknown as ClientProxy),
    send,
  };
};

describe('gateway QueryController', () => {
  it('is an SSE route on POST, not GET', () => {
    const handler = QueryController.prototype.ask;

    expect(Reflect.getMetadata(SSE_METADATA, handler)).toBe(true);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
  });

  it('forwards the question and the bearer token over TCP', async () => {
    const { controller, send } = setup(of(meta, token));

    await controller.ask(body, 'tok-abc', neverAborts);

    expect(send).toHaveBeenCalledWith(
      'llm.query',
      expect.objectContaining({
        accessToken: 'tok-abc',
        question: 'How much notice?',
      }),
    );
  });

  it('maps each event to an SSE message without losing any', async () => {
    const { controller } = setup(of(meta, token));

    const stream = await controller.ask(body, 'tok', neverAborts);
    const messages = await lastValueFrom(stream.pipe(toArray()));

    expect(messages).toEqual<MessageEvent[]>([
      { type: 'meta', data: meta.data },
      { type: 'token', data: token.data },
    ]);
  });

  // The reason the handler awaits the first emission at all: after Nest commits
  // the SSE headers — one macrotask after the handler returns — no failure can
  // be an HTTP status any more.
  it('turns a failure before the first event into a real HTTP status', async () => {
    const { controller } = setup(
      throwError(() => ({
        statusCode: 400,
        message: 'A question is required',
      })),
    );

    const failure = await controller.ask(body, 'tok', neverAborts).then(
      () => null,
      (error: unknown) => error as HttpException,
    );

    expect(failure).toBeInstanceOf(HttpException);
    expect(failure!.getStatus()).toBe(400);
  });

  it('names llm-service in the 503 when the transport itself fails', async () => {
    const { controller } = setup(throwError(() => new Error('ECONNREFUSED')));

    const failure = await controller.ask(body, 'tok', neverAborts).then(
      () => null,
      (error: unknown) => error as HttpException,
    );

    expect(failure!.getStatus()).toBe(503);
    expect(String(failure!.getResponse())).toContain('llm');
  });

  // A failure after the first event is already past the point of no return.
  it('lets a later failure through as a stream error, not an HTTP status', async () => {
    const { controller } = setup(
      concat(
        of(meta),
        throwError(() => new Error('upstream died')),
      ),
    );

    const stream = await controller.ask(body, 'tok', neverAborts);
    const outcome = await lastValueFrom(stream.pipe(toArray())).then(
      () => 'completed',
      () => 'errored',
    );

    expect(outcome).toBe('errored');
  });

  describe('cancellation', () => {
    it('asks llm-service to stop when the client disconnects mid-answer', async () => {
      // A stream that never completes, so the disconnect happens first.
      const { controller, send } = setup(concat(of(meta), NEVER));
      const disconnect = new AbortController();

      await controller.ask(body, 'tok', disconnect.signal);
      send.mockClear();
      send.mockReturnValue(of({ cancelled: true }));
      disconnect.abort();

      expect(send).toHaveBeenCalledWith(
        'llm.query.cancel',
        expect.objectContaining({ queryId: 'q-1', accessToken: 'tok' }),
      );
    });

    // The signal fires on every exit, completion included — cancelling then
    // would send a pointless message after every successful answer.
    it('does not cancel after the stream has completed', async () => {
      const { controller, send } = setup(of(meta, token));
      const disconnect = new AbortController();

      const stream = await controller.ask(body, 'tok', disconnect.signal);
      await lastValueFrom(stream.pipe(toArray()));
      send.mockClear();
      disconnect.abort();

      expect(send).not.toHaveBeenCalled();
    });
  });
});
