import Joi from 'joi';

export const storageSchema = Joi.object({
  S3_ENDPOINT: Joi.string().uri().required(),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  S3_BUCKET: Joi.string().required(),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(true),
});
