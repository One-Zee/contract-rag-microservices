import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService, baseSchema } from '@app/config';
import { rpcAddress, rpcServer } from '@app/rpc';
import { LlmServiceModule } from './llm-service.module.js';

async function readTransportOptions() {
  const context = await NestFactory.createApplicationContext(
    AppConfigModule.forRoot(baseSchema),
    { logger: false },
  );
  const config = context.get(AppConfigService);
  const options = config.rpcEndpoint('llm');
  await context.close();

  // `logger: false` above silenced the static logger for the whole process,
  // not just that context.
  Logger.overrideLogger(new ConsoleLogger());
  return options;
}

async function bootstrap() {
  const options = await readTransportOptions();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    LlmServiceModule,
    rpcServer(options),
  );
  // Without this no lifecycle hook runs on SIGTERM and the Postgres pool is
  // left open.
  app.enableShutdownHooks();
  await app.listen();
  Logger.log(`llm-service listening on ${rpcAddress(options)}`, 'Bootstrap');
}

await bootstrap();
