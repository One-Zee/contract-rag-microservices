import { Logger, Module } from '@nestjs/common';
import { AppConfigService } from '@app/config';
import { EMBEDDINGS, type EmbeddingProvider } from './embedding-provider.js';
import { FakeEmbeddingProvider } from './fake.provider.js';
import { VoyageEmbeddingProvider } from './voyage.provider.js';

/**
 * Builds the provider `EMBEDDING_PROVIDER` names. Exported on its own so a
 * test can exercise the choice without booting a Nest context.
 */
export function createEmbeddingProvider(
  config: AppConfigService,
): EmbeddingProvider {
  const dimensions = config.embeddingDimensions;
  const name = config.embeddingProvider;
  let provider: EmbeddingProvider;
  switch (name) {
    case 'voyage':
      provider = new VoyageEmbeddingProvider({
        apiKey: config.voyageApiKey,
        model: config.embeddingModel,
        dimensions,
      });
      break;
    case 'fake':
      provider = new FakeEmbeddingProvider(dimensions);
      break;
    default: {
      // The schema only lets the two above through; this is the type-level
      // guarantee that adding a third name means adding a case here.
      const unknown: never = name;
      throw new Error(`Unknown embedding provider: ${String(unknown)}`);
    }
  }
  new Logger(EmbeddingsModule.name).log(
    `Embeddings: ${provider.name}/${provider.model} (${provider.dimensions} dimensions)`,
  );
  return provider;
}

/**
 * One `EmbeddingProvider` per process, chosen from the environment. Not
 * `@Global()`: a service that embeds says so in its imports, the same way it
 * says it publishes events by importing `MessagingModule`.
 */
@Module({
  providers: [
    {
      provide: EMBEDDINGS,
      inject: [AppConfigService],
      useFactory: createEmbeddingProvider,
    },
  ],
  exports: [EMBEDDINGS],
})
export class EmbeddingsModule {}
