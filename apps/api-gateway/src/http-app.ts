import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createValidationPipe } from './validation.js';

/**
 * Everything about the HTTP application that a module cannot declare: the
 * global validation pipe and Swagger.
 *
 * Shared by the gateway's bootstrap and the monolith's (ADR 021), so both
 * answer HTTP with the same pipe and the same document — a comparison between
 * the two topologies must not be measuring a difference in configuration.
 */
export function configureHttpApp(app: INestApplication): void {
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
}
