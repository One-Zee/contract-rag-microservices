import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppConfigModule, AppConfigService } from '@app/config';
import { QUEUES, rmqConsumerOptions } from '@app/messaging';
import { inProcessServer, useInProcessTransport } from '@app/rpc';
import { configureHttpApp } from '../../apps/api-gateway/src/http-app.js';
import { monolithSchema } from './monolith.schema.js';

async function bootstrap() {
  // Both before the services' modules are imported, which is why they arrive
  // through a dynamic import below. Each root module validates its
  // configuration when its file is evaluated, and @nestjs/config keeps one
  // validated configuration per process: every module must validate the whole
  // schema, or the last one to load decides how every value is typed — an S3
  // flag arriving as the string "true".
  AppConfigModule.useProcessSchema(monolithSchema);
  // Every client module asks `rpcClient()` which transport to build; here the
  // answer is in-process.
  useInProcessTransport();

  const { MonolithModule } = await import('./monolith.module.js');
  const app = await NestFactory.create<NestExpressApplication>(MonolithModule);
  const config = app.get(AppConfigService);

  configureHttpApp(app);

  // Every module's request handlers, served without leaving the process.
  // `inheritAppConfig` stays off: the gateway's global ValidationPipe belongs
  // to HTTP, and the services never ran behind it.
  app.connectMicroservice(inProcessServer());

  // `document.chunked` still goes through RabbitMQ (ADR 021): indexing settles
  // each message by hand, which needs a real `RmqContext` — and an upload is
  // asynchronous here for the same reasons it is in the microservices.
  app.connectMicroservice(
    rmqConsumerOptions(config.rabbitmqUrl, QUEUES.INDEXING),
  );

  // Without this no lifecycle hook runs on SIGTERM (ADR 007).
  app.enableShutdownHooks();

  await app.startAllMicroservices();
  await app.listen(config.gatewayPort);
  Logger.log(
    `monolith listening on http://localhost:${config.gatewayPort} ` +
      `(Swagger: /api/docs), consuming queue "${QUEUES.INDEXING}"`,
    'Bootstrap',
  );
}

await bootstrap();
