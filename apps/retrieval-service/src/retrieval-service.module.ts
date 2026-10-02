import { Module } from '@nestjs/common';
import {
  AppConfigModule,
  authSchema,
  baseSchema,
  databaseSchema,
  embeddingsSchema,
  retrievalSchema,
} from '@app/config';
import { JwtVerifierModule } from '@app/common';
import { DrizzleModule } from '@app/database';
import { EmbeddingsModule } from '@app/embeddings';
import { TelemetryModule } from '@app/telemetry';
import { RerankModule } from './rerank/rerank.module.js';
import { SearchController } from './search/search.controller.js';
import { SearchRepository } from './search/search.repository.js';
import { SearchService } from './search/search.service.js';

/**
 * Hybrid search over pgvector and Postgres full-text (database), with the
 * question embedded by the same model that embedded the chunks (embeddings).
 * Verifies tokens with the public key only — `JwtVerifierModule`, never the
 * signing key — because the corpus depends on who is asking.
 *
 * No messaging: a search is a question with an answer, not an event.
 */
@Module({
  imports: [
    AppConfigModule.forRoot(
      baseSchema
        .concat(authSchema)
        .concat(databaseSchema)
        .concat(embeddingsSchema)
        .concat(retrievalSchema),
    ),
    TelemetryModule,
    JwtVerifierModule,
    DrizzleModule,
    EmbeddingsModule,
    RerankModule,
  ],
  controllers: [SearchController],
  providers: [SearchService, SearchRepository],
})
export class RetrievalServiceModule {}
