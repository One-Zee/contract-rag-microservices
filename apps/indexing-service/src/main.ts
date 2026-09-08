import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '@app/config';
import { IndexingServiceModule } from './indexing-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(IndexingServiceModule);
  const config = app.get(AppConfigService);
  await app.listen(config.indexingPort);
}
await bootstrap();
