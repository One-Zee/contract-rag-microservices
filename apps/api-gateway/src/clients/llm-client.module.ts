import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';
import { rpcClient } from '@app/rpc';

export const LLM_CLIENT = 'LLM_CLIENT';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: LLM_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) =>
          rpcClient(config.rpcEndpoint('llm')),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class LlmClientModule {}
