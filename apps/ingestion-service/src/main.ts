import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '@app/config';
import { IngestionServiceModule } from './ingestion-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(IngestionServiceModule);
  const config = app.get(AppConfigService);
  await app.listen(config.ingestionPort);
}
await bootstrap();
