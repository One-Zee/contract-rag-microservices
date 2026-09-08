import Joi from 'joi';

/** MinIO / S3-kompatibilno skladište originalnih dokumenata. */
export const storageSchema = Joi.object({
  S3_ENDPOINT: Joi.string().uri().required(),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  S3_BUCKET: Joi.string().required(),
});
