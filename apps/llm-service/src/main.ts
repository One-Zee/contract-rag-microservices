import { NestFactory } from '@nestjs/core';
import { AppConfigService } from '@app/config';
import { LlmServiceModule } from './llm-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(LlmServiceModule);
  const config = app.get(AppConfigService);
  await app.listen(config.llmPort);
}
await bootstrap();
