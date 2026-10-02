import {
  authSchema,
  authSigningSchema,
  baseSchema,
  chunkingSchema,
  databaseSchema,
  embeddingsSchema,
  llmSchema,
  messagingSchema,
  querySchema,
  retrievalSchema,
  storageSchema,
  throttleSchema,
  uploadSchema,
} from '@app/config';

/**
 * Every fragment any service composes: one process runs all six, so it needs
 * every variable any of them needs — `JWT_PRIVATE_KEY` included. "The signing
 * key exists only in auth-service" is a property of the microservice topology,
 * not of this one.
 */
export const monolithSchema = baseSchema
  .concat(authSchema)
  .concat(authSigningSchema)
  .concat(databaseSchema)
  .concat(messagingSchema)
  .concat(storageSchema)
  .concat(uploadSchema)
  .concat(chunkingSchema)
  .concat(embeddingsSchema)
  .concat(retrievalSchema)
  .concat(llmSchema)
  .concat(querySchema)
  .concat(throttleSchema);
