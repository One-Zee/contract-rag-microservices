import { NestFactory } from '@nestjs/core';
import { RetrievalServiceModule } from './retrieval-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(RetrievalServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
