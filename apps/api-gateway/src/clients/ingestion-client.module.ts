import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';
import { rpcClient } from '@app/rpc';

export const INGESTION_CLIENT = 'INGESTION_CLIENT';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: INGESTION_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) =>
          rpcClient({ host: config.ingestionHost, port: config.ingestionPort }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class IngestionClientModule {}
