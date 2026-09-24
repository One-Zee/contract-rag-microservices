import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';

export const RETRIEVAL_CLIENT = 'RETRIEVAL_CLIENT';

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
