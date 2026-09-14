import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from '@app/config';
import { ApiGatewayModule } from './api-gateway.module.js';
import { createValidationPipe } from './validation.js';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);
  const config = app.get(AppConfigService);

  app.useGlobalPipes(createValidationPipe());

  const swagger = new DocumentBuilder()
    .setTitle('ClauseIQ API')
    .setDescription(
      'The only HTTP entry point of the system. The access token is verified ' +
        'locally (RS256); business authorization happens in the service that ' +
        'owns the resource.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swagger),
  );

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
