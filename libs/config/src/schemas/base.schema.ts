import Joi from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';

/**
 * Varijable koje validira svaki servis.
 *
 * Svih šest portova stoji ovdje, a ne u fragmentu po servisu, i svi imaju default —
 * tako nijedan servis ne pada zbog tuđeg porta, a `.env.example` ima jedno mjesto
 * gdje se vidi cijela mapa portova.
 */
export const baseSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid(...Object.values(AppEnvironment))
    .default(AppEnvironment.DEVELOPMENT),

  GATEWAY_PORT: Joi.number().port().default(3000),
  AUTH_PORT: Joi.number().port().default(3001),
  INGESTION_PORT: Joi.number().port().default(3002),
  INDEXING_PORT: Joi.number().port().default(3003),
  RETRIEVAL_PORT: Joi.number().port().default(3004),
  LLM_PORT: Joi.number().port().default(3005),
});
