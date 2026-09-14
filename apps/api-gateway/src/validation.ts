import { ValidationPipe } from '@nestjs/common';

/**
 * `whitelist` strips fields the DTO does not declare; `forbidNonWhitelisted`
 * goes further and rejects such a request outright. This is not mere hygiene:
 * without it a client could send `role: 'admin'` along with a registration and
 * hope something further down the chain reads it.
 *
 * Shared between `main.ts` and the e2e test so the test proves the production
 * configuration rather than one of its own.
 */
export const createValidationPipe = () =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
