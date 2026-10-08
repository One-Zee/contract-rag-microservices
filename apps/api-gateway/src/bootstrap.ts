import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppConfigService } from '@app/config';
import { ApiGatewayModule } from './api-gateway.module.js';
import { configureHttpApp } from './http-app.js';

async function bootstrap() {
  const app =
    await NestFactory.create<NestExpressApplication>(ApiGatewayModule);
  const config = app.get(AppConfigService);

  configureHttpApp(app);

  // The gateway has no database of its own yet, but the call belongs here all
  // the same: it is what makes every `onApplicationShutdown` hook run on a
  // signal, so the services of phases 2-5 inherit the behaviour instead of
  // needing it retrofitted one by one.
  app.enableShutdownHooks();

  await app.listen(config.gatewayPort);
  Logger.log(
    `api-gateway listening on http://localhost:${config.gatewayPort} ` +
      `(Swagger: /api/docs)`,
    'Bootstrap',
  );
}

await bootstrap();
