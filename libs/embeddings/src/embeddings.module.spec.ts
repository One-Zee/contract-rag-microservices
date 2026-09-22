import { Logger } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import { createEmbeddingProvider } from './embeddings.module.js';
import { FakeEmbeddingProvider } from './fake.provider.js';
import { VoyageEmbeddingProvider } from './voyage.provider.js';

Logger.overrideLogger(false);

const config = (overrides: Partial<AppConfigService>): AppConfigService =>
  ({
    embeddingProvider: 'voyage',
    embeddingModel: 'voyage-law-2',
    embeddingDimensions: 1024,
    voyageApiKey: 'pa-key',
    ...overrides,
  }) as AppConfigService;

describe('createEmbeddingProvider', () => {
  it('builds the Voyage provider with the configured model and dimension', () => {
    const provider = createEmbeddingProvider(config({}));

    expect(provider).toBeInstanceOf(VoyageEmbeddingProvider);
    expect(provider.model).toBe('voyage-law-2');
    expect(provider.dimensions).toBe(1024);
  });

  it('builds the fake provider without touching the API key', () => {
    // A getter, not a spread value: the real service throws when the key is
    // absent, and with the fake provider it is.
    const fakeConfig = {
      embeddingProvider: 'fake',
      embeddingDimensions: 1024,
      get voyageApiKey(): string {
        throw new Error(
          'VOYAGE_API_KEY must not be read for the fake provider',
        );
      },
    } as AppConfigService;

    const provider = createEmbeddingProvider(fakeConfig);

    expect(provider).toBeInstanceOf(FakeEmbeddingProvider);
    expect(provider.dimensions).toBe(1024);
  });

  it('rejects a provider name the schema would never let through', () => {
    expect(() =>
      createEmbeddingProvider(
        config({ embeddingProvider: 'openai' as 'voyage' }),
      ),
    ).toThrow('Unknown embedding provider: openai');
  });
});
