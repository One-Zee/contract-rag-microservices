import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '@app/config';
import { ApiGatewayModule } from './api-gateway.module.js';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);
  const config = app.get(AppConfigService);
  await app.listen(config.gatewayPort);
}
await bootstrap();
