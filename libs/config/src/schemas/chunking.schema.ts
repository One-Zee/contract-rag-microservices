import Joi from 'joi';

export const chunkingSchema = Joi.object({
  CHUNK_SIZE_TOKENS: Joi.number().integer().min(50).default(800),
  CHUNK_OVERLAP_TOKENS: Joi.number()
    .integer()
    .min(0)
    .less(Joi.ref('CHUNK_SIZE_TOKENS'))
    .default(120),
  INGESTION_CONCURRENCY: Joi.number().integer().min(1).default(2),
});
