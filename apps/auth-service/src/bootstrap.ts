import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppConfigModule, AppConfigService, baseSchema } from '@app/config';
import { rpcAddress, rpcServer } from '@app/rpc';
import { AuthServiceModule } from './auth-service.module.js';

async function readTransportOptions() {
  const context = await NestFactory.createApplicationContext(
    AppConfigModule.forRoot(baseSchema),
    { logger: false },
  );
  const config = context.get(AppConfigService);
  const options = config.rpcEndpoint('auth');
  await context.close();
  // `logger: false` does not scope to this context — it replaces the static
  // Logger for the whole process, and the real application below would boot
  // in silence (no "listening", no "Postgres pool closed"). Put it back.
  Logger.overrideLogger(new ConsoleLogger());
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
 * signature — but that is the second line, not the first.
 */
async function bootstrap() {
  const options = await readTransportOptions();

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    rpcServer(options),
  );

  // Without this Nest registers no SIGTERM/SIGINT listener, so no shutdown hook
  // runs on Ctrl-C or `docker stop` — the Postgres pool in `DrizzleModule` would
  // never be closed and in-flight queries would be cut off mid-statement.
  app.enableShutdownHooks();

  await app.listen();
  Logger.log(`auth-service listening on ${rpcAddress(options)}`, 'Bootstrap');
}

await bootstrap();
