import { Logger } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import { CohereReranker } from './cohere.reranker.js';
import { NoReranker } from './none.reranker.js';
import { createReranker } from './rerank.module.js';

Logger.overrideLogger(false);

const config = (overrides: Partial<AppConfigService>): AppConfigService =>
  ({
    rerankProvider: 'none',
    rerankModel: 'rerank-v3.5',
    cohereApiKey: 'co-key',
    ...overrides,
  }) as AppConfigService;

describe('createReranker', () => {
  it('builds the identity reranker by default', () => {
    const reranker = createReranker(config({}));

    expect(reranker).toBeInstanceOf(NoReranker);
    expect(reranker.name).toBe('none');
  });

  it('builds the Cohere reranker with the configured model', () => {
    const reranker = createReranker(config({ rerankProvider: 'cohere' }));

    expect(reranker).toBeInstanceOf(CohereReranker);
    expect(reranker.model).toBe('rerank-v3.5');
  });

  it('builds the identity reranker without touching the API key', () => {
    // A getter, not a spread value: the real service throws when the key is
    // absent, and without a reranker it is.
    const noKey = {
      rerankProvider: 'none',
      get cohereApiKey(): string {
        throw new Error('COHERE_API_KEY must not be read for `none`');
      },
    } as AppConfigService;

    expect(createReranker(noKey)).toBeInstanceOf(NoReranker);
  });

  it('rejects a provider name the schema would never let through', () => {
    expect(() =>
      createReranker(config({ rerankProvider: 'voyage' as 'cohere' })),
    ).toThrow('Unknown rerank provider: voyage');
  });
});
