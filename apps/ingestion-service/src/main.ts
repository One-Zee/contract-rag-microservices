import { NestFactory } from '@nestjs/core';
import { IngestionServiceModule } from './ingestion-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(IngestionServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
