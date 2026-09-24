import { Logger, Module } from '@nestjs/common';
import { AppConfigService } from '@app/config';
import { CohereReranker } from './cohere.reranker.js';
import { NoReranker } from './none.reranker.js';
import { RERANKER, type Reranker } from './reranker.js';

/**
 * Builds the reranker `RERANK_PROVIDER` names. Exported on its own so a test
 * can exercise the choice without booting a Nest context.
 */
export function createReranker(config: AppConfigService): Reranker {
  const name = config.rerankProvider;
  let reranker: Reranker;
  switch (name) {
    case 'cohere':
      reranker = new CohereReranker({
        apiKey: config.cohereApiKey,
        model: config.rerankModel,
      });
      break;
    case 'none':
      reranker = new NoReranker();
      break;
    default: {
      // The schema only lets the two above through; this is the type-level
      // guarantee that adding a third name means adding a case here.
      const unknown: never = name;
      throw new Error(`Unknown rerank provider: ${String(unknown)}`);
    }
  }
  new Logger(RerankModule.name).log(
    reranker.model
      ? `Rerank: ${reranker.name}/${reranker.model}`
      : `Rerank: ${reranker.name}`,
  );
  return reranker;
}

@Module({
  providers: [
    {
      provide: RERANKER,
      inject: [AppConfigService],
      useFactory: createReranker,
    },
  ],
  exports: [RERANKER],
})
export class RerankModule {}
