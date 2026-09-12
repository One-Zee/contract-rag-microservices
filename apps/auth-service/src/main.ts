import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService, baseSchema } from '@app/config';
import { AuthServiceModule } from './auth-service.module.js';

/**
 * The transport is configured before the module exists, so host and port have to
 * be read up front. Instead of `process.env`. Validation
 * stays in one place and the ports keep their defaults.
 */
async function readTransportOptions() {
  const context = await NestFactory.createApplicationContext(
    AppConfigModule.forRoot(baseSchema),
    { logger: false },
  );
  const config = context.get(AppConfigService);
  const options = { host: config.authHost, port: config.authPort };
  await context.close();
  return options;
}

/**
 * A pure TCP microservice — no HTTP layer. The gateway is the only
 * internet-facing service; this one listens on the private network.
 *
 * **The host must stay private.** `AUTH_HOST` is `127.0.0.1` locally and the
 * service name on the internal network under Docker Compose, with no `ports:`
 * mapping to the host. The NestJS TCP transport has no mTLS, so keeping the port
 * unexposed is the only thing standing between an attacker and the ability to
 * send arbitrary messages. `RpcAuthGuard` still rejects them without a valid
 * signature — but that is the second line, not the first (ADR 006).
 */
async function bootstrap() {
  const options = await readTransportOptions();

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    { transport: Transport.TCP, options },
  );

  // Without this Nest registers no SIGTERM/SIGINT listener, so no shutdown hook
  // runs on Ctrl-C or `docker stop` — the Postgres pool in `DrizzleModule` would
  // never be closed and in-flight queries would be cut off mid-statement.
  app.enableShutdownHooks();

  await app.listen();
  Logger.log(
    `auth-service listening on tcp://${options.host}:${options.port}`,
    'Bootstrap',
  );
}

await bootstrap();
