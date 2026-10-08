import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppConfigService } from '@app/config';
import { createValidationPipe } from './validation.js';

/**
 * Everything about the HTTP application that a module cannot declare: who the
 * client is behind a proxy, the global validation pipe and Swagger.
 *
 * Shared by the gateway's bootstrap and the monolith's (ADR 021), so both
 * answer HTTP with the same pipe and the same document — a comparison between
 * the two topologies must not be measuring a difference in configuration.
 */
export function configureHttpApp(app: NestExpressApplication): void {
  // The rate limits count by `req.ip`; behind a reverse proxy that is the
  // proxy's address unless Express is told how many hops to look back.
  app.set('trust proxy', app.get(AppConfigService).trustProxyHops);

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
