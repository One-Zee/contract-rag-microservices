import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';
import { rpcClient } from '@app/rpc';

export const RETRIEVAL_CLIENT = 'RETRIEVAL_CLIENT';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: RETRIEVAL_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) =>
          rpcClient({ host: config.retrievalHost, port: config.retrievalPort }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class RetrievalClientModule {}
