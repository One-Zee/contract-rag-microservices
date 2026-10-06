import { existsSync } from 'node:fs';
import Joi from 'joi';
import {
  authSchema,
  authSigningSchema,
} from '@app/config/schemas/auth.schema.js';
import { databaseSchema } from '@app/config/schemas/database.schema.js';

/**
 * The same Joi fragments the Nest auth-service composes, read by hand: what
 * `AppConfigModule` and `AppConfigService` do for a Nest service.
 */
const schema = databaseSchema
  .concat(authSchema)
  .concat(authSigningSchema)
  .concat(Joi.object({ PORT: Joi.number().port().default(3100) }));

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const { error, value } = schema.validate(process.env, {
  allowUnknown: true,
  abortEarly: false,
});
if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const pem = (base64: string): string =>
  Buffer.from(base64, 'base64').toString('utf8');

export const config = {
  port: value.PORT as number,
  databaseUrl: value.DATABASE_URL as string,
  privateKey: pem(value.JWT_PRIVATE_KEY),
  publicKey: pem(value.JWT_PUBLIC_KEY),
  issuer: value.JWT_ISSUER as string,
  audience: value.JWT_AUDIENCE as string,
  accessTtl: value.JWT_EXPIRES_IN as string,
  refreshTtl: value.REFRESH_EXPIRES_IN as string,
  registrationEnabled: value.AUTH_REGISTRATION_ENABLED as boolean,
};
