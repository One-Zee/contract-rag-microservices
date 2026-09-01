import { NestFactory } from '@nestjs/core';
import { IndexingServiceModule } from './indexing-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(IndexingServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
