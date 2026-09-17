import Joi from 'joi';

export const uploadSchema = Joi.object({
  UPLOAD_MAX_BYTES: Joi.number().integer().min(1).default(10_485_760),
});
