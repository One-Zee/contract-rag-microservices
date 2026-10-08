import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AppConfigModule,
  AppConfigService,
  baseSchema,
  messagingSchema,
} from '@app/config';
import { QUEUES, rmqConsumerOptions } from '@app/messaging';
import { IndexingServiceModule } from './indexing-service.module.js';

/** `amqp://user:secret@host:5672` → `host:5672` — credentials never reach a log line. */
const describeBroker = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid RABBITMQ_URL>';
  }
};

async function readTransportOptions() {
  const context = await NestFactory.createApplicationContext(
    AppConfigModule.forRoot(baseSchema.concat(messagingSchema)),
    { logger: false },
  );
  const url = context.get(AppConfigService).rabbitmqUrl;
  await context.close();

  // `logger: false` above silenced the static Logger for the whole process,
  // not just that context — restore it before anything worth reading is logged.
  Logger.overrideLogger(new ConsoleLogger());
  return { url, options: rmqConsumerOptions(url, QUEUES.INDEXING) };
}

async function bootstrap() {
  const { url, options } = await readTransportOptions();
  const app = await NestFactory.createMicroservice(
    IndexingServiceModule,
    options,
  );
  // Without this no lifecycle hook runs on SIGTERM: the pool and the broker
  // connection would be left open, and a document mid-batch not waited for.
  app.enableShutdownHooks();
  await app.listen();
  Logger.log(
    `indexing-service consuming queue "${QUEUES.INDEXING}" on ${describeBroker(url)}`,
    'Bootstrap',
  );
}

await bootstrap();
