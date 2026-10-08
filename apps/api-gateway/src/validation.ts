import { ValidationPipe } from '@nestjs/common';

/**
 * `whitelist` strips fields the DTO does not declare; `forbidNonWhitelisted`
 * goes further and rejects such a request outright. This is not mere hygiene:
 * without it a client could send `role: 'admin'` along with a registration and
 * hope something further down the chain reads it.
 *
 * Shared between `configureHttpApp` (the gateway and the monolith) and the e2e
 * suites, so the tests prove the production configuration rather than one of
 * their own.
 */
export const createValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
