import { lastValueFrom, toArray } from 'rxjs';
import { RpcAuthGuard } from '@app/common';
import type {
  AskQuestionRpcPayload,
  AuthContext,
  QueryStreamEvent,
} from '@app/common';
import { QueryController } from './query.controller.js';
import type { QueryService } from './query.service.js';

const analyst: AuthContext = {
  userId: 'u-1',
  email: 'analyst@x.ba',
  roles: ['analyst'],
};

const payload = (
  overrides: Partial<AskQuestionRpcPayload> = {},
): AskQuestionRpcPayload => ({
  accessToken: 'header.payload.signature',
  question: 'How much notice?',
  ...overrides,
});

const events: QueryStreamEvent[] = [
  { type: 'token', data: { text: 'Ninety' } },
  { type: 'token', data: { text: ' days.' } },
];

const setup = () => {
  const query = {
    ask: vi.fn(async function* () {
      for (const event of events) {
        yield event;
      }
    }),
    history: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
    cancel: vi.fn().mockReturnValue(true),
  };
  return {
    controller: new QueryController(query as unknown as QueryService),
    query,
  };
};

describe('QueryController', () => {
  it('passes the request and the caller’s token through to the service', async () => {
    const { controller, query } = setup();

    await lastValueFrom(
      controller
        .ask(payload({ documentId: 'd-1', mode: 'vector', limit: 3 }), analyst)
        .pipe(toArray()),
    );

    expect(query.ask).toHaveBeenCalledWith(
      analyst,
      {
        question: 'How much notice?',
        documentId: 'd-1',
        mode: 'vector',
        limit: 3,
        rerank: undefined,
      },
      'header.payload.signature',
    );
  });

  // The transport delivers every emission separately; a handler that collapsed
  // the generator into one value would turn streaming back into waiting.
  it('returns an observable that emits every event', async () => {
    const { controller } = setup();

    const emitted = await lastValueFrom(
      controller.ask(payload(), analyst).pipe(toArray()),
    );

    expect(emitted).toEqual(events);
  });

  // Identity comes from the verified token and nowhere else: a payload field
  // claiming to be a user id must not become the asker (ADR 006).
  it('takes the asker from the token, not from the payload', async () => {
    const { controller, query } = setup();

    await lastValueFrom(
      controller
        .ask(
          { ...payload(), userId: 'u-somebody-else' } as AskQuestionRpcPayload,
          analyst,
        )
        .pipe(toArray()),
    );

    expect(query.ask).toHaveBeenCalledWith(
      analyst,
      expect.anything(),
      expect.any(String),
    );
  });

  it('reads history for the caller only', async () => {
    const { controller, query } = setup();

    await controller.history(
      { accessToken: 'tok', page: 2, limit: 10 },
      analyst,
    );

    expect(query.history).toHaveBeenCalledWith(analyst, 2, 10);
  });

  it('reports whether a cancel arrived in time', () => {
    const { controller, query } = setup();

    expect(controller.cancel({ accessToken: 'tok', queryId: 'q-1' })).toEqual({
      cancelled: true,
    });
    expect(query.cancel).toHaveBeenCalledWith('q-1');
  });

  it('guards every handler, so an unsigned payload never reaches the service', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      QueryController,
    ) as unknown[];

    expect(guards).toContain(RpcAuthGuard);
  });
});
