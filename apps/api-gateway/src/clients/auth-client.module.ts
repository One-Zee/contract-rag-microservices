import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService } from '@app/config';

export const AUTH_CLIENT = 'AUTH_CLIENT';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: AUTH_CLIENT,
        imports: [AppConfigModule],
        inject: [AppConfigService],
        useFactory: (config: AppConfigService) => ({
          transport: Transport.TCP,
          options: { host: config.authHost, port: config.authPort },
        }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class AuthClientModule {}
