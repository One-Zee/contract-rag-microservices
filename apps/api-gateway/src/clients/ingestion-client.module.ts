import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';

export const INGESTION_CLIENT = 'INGESTION_CLIENT';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: INGESTION_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) => ({
          transport: Transport.TCP,
          options: { host: config.ingestionHost, port: config.ingestionPort },
        }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class IngestionClientModule {}
