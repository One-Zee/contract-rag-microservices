import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService, baseSchema } from '@app/config';
import { rpcServer } from '@app/rpc';
import { IngestionServiceModule } from './ingestion-service.module.js';

async function readTransportOptions() {
  const context = await NestFactory.createApplicationContext(
    AppConfigModule.forRoot(baseSchema),
    { logger: false },
  );
  const config = context.get(AppConfigService);
  const options = { host: config.ingestionHost, port: config.ingestionPort };
  await context.close();

  Logger.overrideLogger(new ConsoleLogger());
  return options;
}

async function bootstrap() {
  const options = await readTransportOptions();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    IngestionServiceModule,
    rpcServer(options),
  );
  // Without this no lifecycle hook runs on SIGTERM: the pool, the S3 client
  // and the broker connection would all be left open.
  app.enableShutdownHooks();
  await app.listen();
  Logger.log(
    `ingestion-service listening on tcp://${options.host}:${options.port}`,
    'Bootstrap',
  );
}

await bootstrap();
