import Joi from 'joi';

export const messagingSchema = Joi.object({
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),
});
