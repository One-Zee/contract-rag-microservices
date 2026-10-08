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

  // How many reverse proxies stand in front of the gateway — Express's
  // `trust proxy` as a hop count. The budgets count by `req.ip`, which behind
  // a proxy is the proxy's own address: every client would share one budget.
  // With N, the address N hops back in X-Forwarded-For counts instead. 0 (the
  // default) believes no X-Forwarded-For at all, which is right whenever
  // clients connect directly — any higher value lets them pick their address.
  TRUST_PROXY: Joi.number().integer().min(0).empty('').default(0),
});
