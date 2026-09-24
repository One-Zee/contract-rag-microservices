import { RpcAuthGuard } from '@app/common';
import type { AuthContext, SearchRpcPayload } from '@app/common';
import { SearchController } from './search.controller.js';
import type { SearchService } from './search.service.js';

const analyst: AuthContext = {
  userId: 'u-1',
  email: 'analyst@x.ba',
  roles: ['analyst'],
};

const payload = (
  overrides: Partial<SearchRpcPayload> = {},
): SearchRpcPayload => ({
  accessToken: 'header.payload.signature',
  query: 'termination notice',
  mode: 'hybrid',
  ...overrides,
});

const setup = () => {
  const search = { search: vi.fn().mockResolvedValue({ results: [] }) };
  return {
    controller: new SearchController(search as unknown as SearchService),
    search,
  };
};

describe('SearchController', () => {
  it('passes the request through to the service', async () => {
    const { controller, search } = setup();

    await controller.run(
      payload({ limit: 3, documentId: 'doc-1', rerank: true }),
      analyst,
    );

    expect(search.search).toHaveBeenCalledWith(analyst, {
      query: 'termination notice',
      mode: 'hybrid',
      limit: 3,
      documentId: 'doc-1',
      rerank: true,
    });
  });

  // Identity comes from the verified token and nowhere else: a payload field
  // claiming to be a user id must not become the viewer (ADR 006).
  it('takes the viewer from the token, not from the payload', async () => {
    const { controller, search } = setup();

    await controller.run(
      { ...payload(), userId: 'u-somebody-else' } as SearchRpcPayload,
      analyst,
    );

    expect(search.search).toHaveBeenCalledWith(analyst, expect.anything());
  });

  it('guards the handler, so an unsigned payload never reaches the service', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      SearchController,
    ) as unknown[];

    expect(guards).toContain(RpcAuthGuard);
  });
});
