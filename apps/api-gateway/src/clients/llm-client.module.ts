import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';

export const LLM_CLIENT = 'LLM_CLIENT';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: LLM_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) => ({
          transport: Transport.TCP,
          options: { host: config.llmHost, port: config.llmPort },
        }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class LlmClientModule {}
