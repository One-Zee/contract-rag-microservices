import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '@app/config';
import { AuthServiceModule } from './auth-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AuthServiceModule);
  const config = app.get(AppConfigService);
  await app.listen(config.authPort);
}
await bootstrap();
