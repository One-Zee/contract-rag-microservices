import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from '@app/config';
import { ApiGatewayModule } from './api-gateway.module.js';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);
  const config = app.get(AppConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

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

  await app.listen(config.gatewayPort);
  Logger.log(
    `api-gateway listening on http://localhost:${config.gatewayPort} ` +
      `(Swagger: /api/docs)`,
    'Bootstrap',
  );
}

await bootstrap();
