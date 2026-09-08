import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '@app/config';
import { RetrievalServiceModule } from './retrieval-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(RetrievalServiceModule);
  const config = app.get(AppConfigService);
  await app.listen(config.retrievalPort);
}
await bootstrap();
