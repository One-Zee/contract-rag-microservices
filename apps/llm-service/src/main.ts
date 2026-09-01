import { NestFactory } from '@nestjs/core';
import { LlmServiceModule } from './llm-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(LlmServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
