import Joi from 'joi';

/**
 * JWT s rotacijom refresh tokena.
 *
 * `JWT_SECRET` ima minimalnu dužinu jer je `.env.example` namjerno pun placeholderom
 * (`promijeni-me`) — kratak ključ u produkciji je tiha ranjivost, pa neka pukne odmah.
 * Trajanja su string jer ih `@nestjs/jwt` prima u zapisu tipa `15m` / `7d`.
 */
const durationPattern = /^\d+[smhd]$/;

export const authSchema = Joi.object({
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().pattern(durationPattern).default('15m'),
  REFRESH_EXPIRES_IN: Joi.string().pattern(durationPattern).default('7d'),
});
