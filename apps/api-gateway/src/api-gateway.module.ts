import { Module } from '@nestjs/common';
import { AppConfigModule, authSchema, baseSchema } from '@app/config';
import { ApiGatewayController } from './api-gateway.controller.js';
import { ApiGatewayService } from './api-gateway.service.js';

@Module({
  // Gateway verifikuje JWT, ali sam ne dira bazu, skladište ni brokera.
  imports: [AppConfigModule.forRoot(baseSchema.concat(authSchema))],
  controllers: [ApiGatewayController],
  providers: [ApiGatewayService],
})
export class ApiGatewayModule {}
