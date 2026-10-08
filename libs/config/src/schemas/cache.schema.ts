import Joi from 'joi';

export const cacheSchema = Joi.object({
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
});
