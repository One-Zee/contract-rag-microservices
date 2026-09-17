import Joi from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';

/**
 * Variables every service validates.
 */
export const baseSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid(...Object.values(AppEnvironment))
    .default(AppEnvironment.DEVELOPMENT),

  GATEWAY_PORT: Joi.number().port().default(3000),
  AUTH_PORT: Joi.number().port().default(3001),
  AUTH_HOST: Joi.string().hostname().default('127.0.0.1'),
  INGESTION_HOST: Joi.string().hostname().default('127.0.0.1'),
  INGESTION_PORT: Joi.number().port().default(3002),
  INDEXING_PORT: Joi.number().port().default(3003),
  RETRIEVAL_PORT: Joi.number().port().default(3004),
  LLM_PORT: Joi.number().port().default(3005),
});
