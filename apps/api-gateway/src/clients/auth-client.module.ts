import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';
import { rpcClient } from '@app/rpc';

export const AUTH_CLIENT = 'AUTH_CLIENT';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: AUTH_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) =>
          rpcClient(config.rpcEndpoint('auth')),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class AuthClientModule {}
