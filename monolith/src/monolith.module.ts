import { Module } from '@nestjs/common';
import { ApiGatewayModule } from '../../apps/api-gateway/src/api-gateway.module.js';
import { AuthServiceModule } from '../../apps/auth-service/src/auth-service.module.js';
import { IndexingServiceModule } from '../../apps/indexing-service/src/indexing-service.module.js';
import { IngestionServiceModule } from '../../apps/ingestion-service/src/ingestion-service.module.js';
import { LlmServiceModule } from '../../apps/llm-service/src/llm-service.module.js';
import { RetrievalServiceModule } from '../../apps/retrieval-service/src/retrieval-service.module.js';

/**
 * The six services as one application  — their root modules, as
 * they are, with nothing reimplemented. Two things change, both set in
 * `bootstrap.ts` before this file is imported: every client is built for the
 * in-process transport, and every module validates the complete configuration
 * schema instead of its own fragment of it.
 *
 * `.dependency-cruiser.cjs` holds this file to root modules: the monolith may
 * compose the services, never reach into them.
 */
@Module({
  imports: [
    ApiGatewayModule,
    AuthServiceModule,
    IngestionServiceModule,
    IndexingServiceModule,
    RetrievalServiceModule,
    LlmServiceModule,
  ],
})
export class MonolithModule {}
