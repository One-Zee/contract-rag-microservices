import Joi from 'joi';

/**
 * JWT with an asymmetric signature (RS256) and refresh token rotation.
 *
 * The fragment is deliberately split in two: `authSchema` carries everything a
 * token **verifier** needs, `authSigningSchema` only what the **issuer** needs.
 * That makes "the private key exists only in auth-service" a consequence of the
 * composition rather than a promise — a gateway that does not compose
 * `authSigningSchema` has no configuration path to the signing key. The same
 * style of argument as in ADR 003.
 */
const durationPattern = /^\d+[smhd]$/;

/**
 * PEM is kept base64-encoded in `.env`. Raw PEM contains line breaks, which
 * dotenv cuts at the first one, so the key would silently arrive truncated — and
 * `jsonwebtoken` would only report it at the first signing attempt, with an
 * error that does not name the real cause.
 */
const base64Pem = Joi.string()
  .base64()
  .custom((value: string, helpers) => {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded.includes('-----BEGIN')) {
      return helpers.error('any.invalid');
    }
    return value;
  }, 'base64-encoded PEM')
  // `{{#label}}` keeps the variable name in the message. Without it the error
  // reads "must be a base64-encoded PEM key" with no hint as to which key — and
  // naming the cause is the whole point of validating (ADR 003).
  .messages({
    'any.invalid':
      '{{#label}} must be a base64-encoded PEM key on a single line (see .env.example)',
  });

/**
 * Token verification — the gateway and every protected service.
 */
export const authSchema = Joi.object({
  JWT_PUBLIC_KEY: base64Pem.required(),
  JWT_ISSUER: Joi.string().default('clauseiq-auth'),
  JWT_AUDIENCE: Joi.string().default('clauseiq-api'),
  JWT_EXPIRES_IN: Joi.string().pattern(durationPattern).default('15m'),
});

/**
 * Token issuance — `auth-service` only.
 */
export const authSigningSchema = Joi.object({
  JWT_PRIVATE_KEY: base64Pem.required(),
  REFRESH_EXPIRES_IN: Joi.string().pattern(durationPattern).default('7d'),

  // Registration is the one public way to obtain tokens, so whether it is open
  // belongs with the issuer. A switch, not an invitation system: register the
  // accounts you need, then close it
  AUTH_REGISTRATION_ENABLED: Joi.boolean().default(true),
});
