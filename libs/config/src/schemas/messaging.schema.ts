import Joi from 'joi';

/** RabbitMQ (ingestion → indexing handoff) i Redis (keš, rate limiting). */
export const messagingSchema = Joi.object({
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),
});
