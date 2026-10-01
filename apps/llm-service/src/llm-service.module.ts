import { Module } from '@nestjs/common';
import { JwtVerifierModule } from '@app/common';
import {
  AppConfigModule,
  authSchema,
  baseSchema,
  databaseSchema,
  llmSchema,
  querySchema,
} from '@app/config';
import { DrizzleModule } from '@app/database';
import { RetrievalClientModule } from './clients/retrieval-client.module.js';
import { LlmModule } from './llm/llm.module.js';
import { QueryCancellationRegistry } from './query/cancellation.registry.js';
import { QueryController } from './query/query.controller.js';
import { QueryRepository } from './query/query.repository.js';
import { QueryService } from './query/query.service.js';

/**
 * Prompt construction, the model call, streaming and citation mapping.
 *
 * It reaches the corpus only through retrieval-service — it has no chunk
 * queries of its own — but it does need `DATABASE_URL`
 */
@Module({
  imports: [
    AppConfigModule.forRoot(
      baseSchema
        .concat(authSchema)
        .concat(databaseSchema)
        .concat(llmSchema)
        .concat(querySchema),
    ),
    JwtVerifierModule,
    DrizzleModule,
    RetrievalClientModule,
    LlmModule,
  ],
  controllers: [QueryController],
  providers: [QueryService, QueryRepository, QueryCancellationRegistry],
})
export class LlmServiceModule {}
