import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService, baseSchema } from '@app/config';
import { RetrievalServiceModule } from './retrieval-service.module.js';

async function readTransportOptions() {
  const context = await NestFactory.createApplicationContext(
    AppConfigModule.forRoot(baseSchema),
    { logger: false },
  );
  const config = context.get(AppConfigService);
  const options = { host: config.retrievalHost, port: config.retrievalPort };
  await context.close();

  // `logger: false` above silenced the static logger for the whole process,
  // not just that context.
  Logger.overrideLogger(new ConsoleLogger());
  return options;
}

async function bootstrap() {
  const options = await readTransportOptions();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    RetrievalServiceModule,
    { transport: Transport.TCP, options },
  );
  // Without this no lifecycle hook runs on SIGTERM and the Postgres pool is
  // left open (ADR 007).
  app.enableShutdownHooks();
  await app.listen();
  Logger.log(
    `retrieval-service listening on tcp://${options.host}:${options.port}`,
    'Bootstrap',
  );
}

await bootstrap();
