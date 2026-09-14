import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AppConfigModule, authSchema, baseSchema } from '@app/config';
import { HealthController } from './api-gateway.controller.js';
import { AuthClientModule } from './clients/auth-client.module.js';
import { AuthController } from './auth/auth.controller.js';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { UsersController } from './users/users.controller.js';

@Module({
  imports: [
    AppConfigModule.forRoot(baseSchema.concat(authSchema)),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    AuthClientModule,
  ],
  controllers: [HealthController, AuthController, UsersController],
  providers: [JwtStrategy],
})
export class ApiGatewayModule {}
