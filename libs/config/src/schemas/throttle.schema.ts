import Joi from 'joi';

/**
 * Rate limiting at the gateway — composed by api-gateway alone.
 *
 * Two budgets per client IP over the same window: `THROTTLE_LIMIT` for every
 * route, and the much smaller `THROTTLE_STRICT_LIMIT` for the routes that cost
 * something to answer — password hashing on `/auth/register`, `/auth/login`
 * and `/auth/refresh`, a model call on `POST /query`.
 *
 * `THROTTLE_ENABLED=false` is for load tests and nothing else: k6 on one
 * machine is one IP address, so a measurement taken with the throttler on
 * would measure the throttler.
 */
export const throttleSchema = Joi.object({
  THROTTLE_ENABLED: Joi.boolean().default(true),

  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),

  THROTTLE_LIMIT: Joi.number().integer().min(1).default(120),

  // Counted separately from THROTTLE_LIMIT, so a value above it changes
  // nothing: the general budget runs out first.
  THROTTLE_STRICT_LIMIT: Joi.number().integer().min(1).default(10),
});
