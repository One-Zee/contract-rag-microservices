import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';

export const RETRIEVAL_CLIENT = 'RETRIEVAL_CLIENT';

/**
 * llm-service is a client of retrieval-service - `api-gateway → llm-service →
 * retrieval-service`.
 *
 * A copy of the gateway's module of the same name rather than a shared one:
 * `no-cross-app-imports` forbids importing it from there, and a lib holding
 * four lines of transport configuration would be a worse answer than two
 * copies that are allowed to drift apart (they have different reasons to
 * change — the gateway's `GET /search` and this).
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: RETRIEVAL_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) => ({
          transport: Transport.TCP,
          options: { host: config.retrievalHost, port: config.retrievalPort },
        }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class RetrievalClientModule {}
