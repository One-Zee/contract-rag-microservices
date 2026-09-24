import { generateKeyPairSync } from 'node:crypto';
import type { ObjectSchema } from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';
import { authSchema, authSigningSchema } from './auth.schema.js';
import { baseSchema } from './base.schema.js';
import { chunkingSchema } from './chunking.schema.js';
import { databaseSchema } from './database.schema.js';
import { embeddingsSchema } from './embeddings.schema.js';
import { llmSchema } from './llm.schema.js';
import { messagingSchema } from './messaging.schema.js';
import { retrievalSchema } from './retrieval.schema.js';
import { storageSchema } from './storage.schema.js';
import { uploadSchema } from './upload.schema.js';

/**
 * The same options AppConfigModule.forRoot sets centrally. Without them Joi
 * rejects unknown keys and reports only the first error, so the tests would be
 * measuring something that never happens in the application.
 */
const withOptions = (schema: ObjectSchema): ObjectSchema =>
  schema.options({ abortEarly: false, allowUnknown: true });

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const b64 = (pem: string) => Buffer.from(pem, 'utf8').toString('base64');

const validEnv = {
  DATABASE_URL: 'postgresql://app:dev@localhost:5432/contracts',
  JWT_PUBLIC_KEY: b64(publicKey),
  JWT_PRIVATE_KEY: b64(privateKey),
};

describe('env validation schemas', () => {
  // The same composition as in apps/auth-service/src/auth-service.module.ts.
  const authServiceSchema = withOptions(
    baseSchema
      .concat(authSchema)
      .concat(authSigningSchema)
      .concat(databaseSchema),
  );
  // The same composition as in apps/api-gateway/src/api-gateway.module.ts.
  const gatewaySchema = withOptions(
    baseSchema.concat(authSchema).concat(uploadSchema),
  );
  // The same composition as in apps/ingestion-service/src/ingestion-service.module.ts.
  const ingestionSchema = withOptions(
    baseSchema
      .concat(authSchema)
      .concat(databaseSchema)
      .concat(storageSchema)
      .concat(messagingSchema)
      .concat(uploadSchema)
      .concat(chunkingSchema),
  );
  const ingestionEnv = {
    DATABASE_URL: validEnv.DATABASE_URL,
    JWT_PUBLIC_KEY: validEnv.JWT_PUBLIC_KEY,
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    S3_BUCKET: 'contracts',
    RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  };

  it('accepts a valid environment and applies the defaults', () => {
    const { error, value } = authServiceSchema.validate(validEnv);

    expect(error).toBeUndefined();
    expect(value.NODE_ENV).toBe(AppEnvironment.DEVELOPMENT);
    expect(value.AUTH_PORT).toBe(3001);
    expect(value.AUTH_HOST).toBe('127.0.0.1');
    expect(value.JWT_EXPIRES_IN).toBe('15m');
    expect(value.JWT_ISSUER).toBe('clauseiq-auth');
    expect(value.JWT_AUDIENCE).toBe('clauseiq-api');
  });

  it('rejects an environment without DATABASE_URL and names the variable', () => {
    const { DATABASE_URL: _omitted, ...rest } = validEnv;
    const { error } = authServiceSchema.validate(rest);

    expect(error).toBeDefined();
    expect(error!.message).toContain('DATABASE_URL');
  });

  it('reports every error at once (abortEarly: false)', () => {
    const { error } = authServiceSchema.validate({});

    expect(error!.details).toHaveLength(3);
    expect(error!.message).toContain('DATABASE_URL');
    expect(error!.message).toContain('JWT_PUBLIC_KEY');
    expect(error!.message).toContain('JWT_PRIVATE_KEY');
  });

  it('rejects a DATABASE_URL that is not a postgres URI', () => {
    const { error } = authServiceSchema.validate({
      ...validEnv,
      DATABASE_URL: 'not-a-url',
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('DATABASE_URL');
  });

  it('tolerates variables the service does not use (allowUnknown)', () => {
    const { error } = authServiceSchema.validate({
      ...validEnv,
      S3_BUCKET: 'contracts',
      RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
    });

    expect(error).toBeUndefined();
  });

  it('lets llm-service boot without DATABASE_URL or any EMBEDDING_* variable', () => {
    const schema = withOptions(baseSchema.concat(llmSchema));

    expect(schema.validate({}).error).toBeUndefined();
  });

  describe('indexing-service (phase 3)', () => {
    // The same composition as in apps/indexing-service/src/indexing-service.module.ts.
    const indexingSchema = withOptions(
      baseSchema
        .concat(databaseSchema)
        .concat(messagingSchema)
        .concat(embeddingsSchema),
    );
    const indexingEnv = {
      DATABASE_URL: validEnv.DATABASE_URL,
      RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
      VOYAGE_API_KEY: 'pa-test-key',
    };

    it('accepts a valid environment and applies the defaults', () => {
      const { error, value } = indexingSchema.validate(indexingEnv);

      expect(error).toBeUndefined();
      expect(value.EMBEDDING_PROVIDER).toBe('voyage');
      expect(value.EMBEDDING_MODEL).toBe('voyage-law-2');
      expect(value.EMBEDDING_DIMENSIONS).toBe(1024);
      expect(value.EMBEDDING_BATCH_SIZE).toBe(100);
    });

    it('locks EMBEDDING_DIMENSIONS to 1024 (vector(1024) in migration 0001)', () => {
      expect(
        indexingSchema.validate({ ...indexingEnv, EMBEDDING_DIMENSIONS: 768 })
          .error!.message,
      ).toContain('EMBEDDING_DIMENSIONS');
      expect(
        indexingSchema.validate({ ...indexingEnv, EMBEDDING_DIMENSIONS: 1024 })
          .error,
      ).toBeUndefined();
    });

    it('requires VOYAGE_API_KEY when the provider is voyage — also by default', () => {
      const { VOYAGE_API_KEY: _omitted, ...withoutKey } = indexingEnv;

      expect(indexingSchema.validate(withoutKey).error!.message).toContain(
        'VOYAGE_API_KEY',
      );
      expect(
        indexingSchema.validate({
          ...withoutKey,
          EMBEDDING_PROVIDER: 'voyage',
        }).error!.message,
      ).toContain('VOYAGE_API_KEY');
    });

    it('lets the fake provider boot without a key', () => {
      const { VOYAGE_API_KEY: _omitted, ...withoutKey } = indexingEnv;
      const { error, value } = indexingSchema.validate({
        ...withoutKey,
        EMBEDDING_PROVIDER: 'fake',
      });

      expect(error).toBeUndefined();
      expect(value.EMBEDDING_PROVIDER).toBe('fake');
    });

    it('refuses the fake provider in production', () => {
      const { error } = indexingSchema.validate({
        ...indexingEnv,
        NODE_ENV: AppEnvironment.PRODUCTION,
        EMBEDDING_PROVIDER: 'fake',
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain('EMBEDDING_PROVIDER');
    });

    it('rejects an unknown provider', () => {
      const { error } = indexingSchema.validate({
        ...indexingEnv,
        EMBEDDING_PROVIDER: 'openai',
      });

      expect(error!.message).toContain('EMBEDDING_PROVIDER');
    });

    it('keeps the batch size inside what one Voyage request accepts', () => {
      expect(
        indexingSchema.validate({ ...indexingEnv, EMBEDDING_BATCH_SIZE: 0 })
          .error,
      ).toBeDefined();
      expect(
        indexingSchema.validate({ ...indexingEnv, EMBEDDING_BATCH_SIZE: 1001 })
          .error,
      ).toBeDefined();
      expect(
        indexingSchema.validate({ ...indexingEnv, EMBEDDING_BATCH_SIZE: '250' })
          .value.EMBEDDING_BATCH_SIZE,
      ).toBe(250);
    });

    it('names every missing infrastructure variable at once', () => {
      const { error } = indexingSchema.validate({});

      for (const name of ['DATABASE_URL', 'RABBITMQ_URL', 'VOYAGE_API_KEY']) {
        expect(error!.message).toContain(name);
      }
    });
  });

  describe('retrieval-service (phase 4)', () => {
    // The same composition as in apps/retrieval-service/src/retrieval-service.module.ts.
    const retrievalSchemaFull = withOptions(
      baseSchema
        .concat(authSchema)
        .concat(databaseSchema)
        .concat(embeddingsSchema)
        .concat(retrievalSchema),
    );
    const retrievalEnv = {
      DATABASE_URL: validEnv.DATABASE_URL,
      JWT_PUBLIC_KEY: validEnv.JWT_PUBLIC_KEY,
      VOYAGE_API_KEY: 'pa-test-key',
    };

    it('accepts a valid environment and applies the defaults', () => {
      const { error, value } = retrievalSchemaFull.validate(retrievalEnv);

      expect(error).toBeUndefined();
      expect(value.RETRIEVAL_HOST).toBe('127.0.0.1');
      expect(value.RETRIEVAL_PORT).toBe(3004);
      expect(value.SEARCH_CANDIDATES).toBe(20);
      expect(value.SEARCH_FUSED).toBe(10);
      expect(value.SEARCH_TOP_K).toBe(5);
      expect(value.RRF_K).toBe(60);
      expect(value.HNSW_EF_SEARCH).toBe(100);
      expect(value.RERANK_PROVIDER).toBe('none');
      expect(value.RERANK_MODEL).toBe('rerank-v3.5');
    });

    it('requires COHERE_API_KEY when the reranker is cohere, but not otherwise', () => {
      expect(
        retrievalSchemaFull.validate({
          ...retrievalEnv,
          RERANK_PROVIDER: 'cohere',
        }).error!.message,
      ).toContain('COHERE_API_KEY');
      expect(
        retrievalSchemaFull.validate({
          ...retrievalEnv,
          RERANK_PROVIDER: 'cohere',
          COHERE_API_KEY: 'co-test-key',
        }).error,
      ).toBeUndefined();
    });

    it('boots without a reranking key by default', () => {
      const { error, value } = retrievalSchemaFull.validate(retrievalEnv);

      expect(error).toBeUndefined();
      expect(value.COHERE_API_KEY).toBeUndefined();
    });

    it('rejects an unknown reranker', () => {
      const { error } = retrievalSchemaFull.validate({
        ...retrievalEnv,
        RERANK_PROVIDER: 'voyage',
      });

      expect(error!.message).toContain('RERANK_PROVIDER');
    });

    // Reranking cannot rescue a candidate the branches never retrieved, and
    // fusion cannot return more than it was given: the three limits have to
    // narrow in that order or a run silently returns fewer results than asked.
    it('keeps SEARCH_TOP_K ≤ SEARCH_FUSED ≤ SEARCH_CANDIDATES', () => {
      expect(
        retrievalSchemaFull.validate({
          ...retrievalEnv,
          SEARCH_CANDIDATES: 20,
          SEARCH_FUSED: 50,
        }).error!.message,
      ).toContain('SEARCH_FUSED');
      expect(
        retrievalSchemaFull.validate({
          ...retrievalEnv,
          SEARCH_FUSED: 10,
          SEARCH_TOP_K: 11,
        }).error!.message,
      ).toContain('SEARCH_TOP_K');
      expect(
        retrievalSchemaFull.validate({
          ...retrievalEnv,
          SEARCH_CANDIDATES: 50,
          SEARCH_FUSED: 20,
          SEARCH_TOP_K: 20,
        }).error,
      ).toBeUndefined();
    });

    // Joi applies a default without re-checking it, so plain numeric defaults
    // would let `SEARCH_CANDIDATES=5` sit next to a fusion window of 10.
    it('narrows the defaults when a lower candidate count is set', () => {
      const { error, value } = retrievalSchemaFull.validate({
        ...retrievalEnv,
        SEARCH_CANDIDATES: 5,
      });

      expect(error).toBeUndefined();
      expect(value.SEARCH_FUSED).toBe(5);
      expect(value.SEARCH_TOP_K).toBe(5);
    });

    it('rejects a candidate count outside what one search may scan', () => {
      expect(
        retrievalSchemaFull.validate({
          ...retrievalEnv,
          SEARCH_CANDIDATES: 0,
        }).error,
      ).toBeDefined();
      expect(
        retrievalSchemaFull.validate({
          ...retrievalEnv,
          SEARCH_CANDIDATES: 201,
        }).error,
      ).toBeDefined();
    });

    it('needs the same embedding model as indexing — the key included', () => {
      const { VOYAGE_API_KEY: _omitted, ...withoutKey } = retrievalEnv;

      expect(retrievalSchemaFull.validate(withoutKey).error!.message).toContain(
        'VOYAGE_API_KEY',
      );
    });

    it('lets the gateway boot without any SEARCH_* variable', () => {
      expect(gatewaySchema.validate(validEnv).error).toBeUndefined();
    });
  });

  describe('ingestion-service (phase 2)', () => {
    it('accepts a valid environment and applies the defaults', () => {
      const { error, value } = ingestionSchema.validate(ingestionEnv);

      expect(error).toBeUndefined();
      expect(value.INGESTION_HOST).toBe('127.0.0.1');
      expect(value.INGESTION_PORT).toBe(3002);
      expect(value.S3_REGION).toBe('us-east-1');
      expect(value.S3_FORCE_PATH_STYLE).toBe(true);
      expect(value.UPLOAD_MAX_BYTES).toBe(10_485_760);
      expect(value.CHUNK_SIZE_TOKENS).toBe(800);
      expect(value.CHUNK_OVERLAP_TOKENS).toBe(120);
      expect(value.INGESTION_CONCURRENCY).toBe(2);
    });

    it('boots without REDIS_URL — it never touches the cache', () => {
      const { error } = ingestionSchema.validate(ingestionEnv);

      expect(error).toBeUndefined();
      expect(ingestionEnv).not.toHaveProperty('REDIS_URL');
    });

    it('names every missing infrastructure variable at once', () => {
      const { error } = ingestionSchema.validate({});

      for (const name of [
        'DATABASE_URL',
        'JWT_PUBLIC_KEY',
        'S3_ENDPOINT',
        'S3_ACCESS_KEY',
        'S3_SECRET_KEY',
        'S3_BUCKET',
        'RABBITMQ_URL',
      ]) {
        expect(error!.message).toContain(name);
      }
    });

    it('coerces S3_FORCE_PATH_STYLE from the string dotenv delivers', () => {
      const { value } = ingestionSchema.validate({
        ...ingestionEnv,
        S3_FORCE_PATH_STYLE: 'false',
      });

      expect(value.S3_FORCE_PATH_STYLE).toBe(false);
    });

    it('rejects an overlap that is not smaller than the chunk size', () => {
      const { error } = ingestionSchema.validate({
        ...ingestionEnv,
        CHUNK_SIZE_TOKENS: 200,
        CHUNK_OVERLAP_TOKENS: 200,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain('CHUNK_OVERLAP_TOKENS');
    });

    it('rejects a zero upload limit and a zero concurrency', () => {
      expect(
        ingestionSchema.validate({ ...ingestionEnv, UPLOAD_MAX_BYTES: 0 })
          .error,
      ).toBeDefined();
      expect(
        ingestionSchema.validate({ ...ingestionEnv, INGESTION_CONCURRENCY: 0 })
          .error,
      ).toBeDefined();
    });

    it('lets the gateway boot without any S3 or RabbitMQ variable', () => {
      const { error, value } = gatewaySchema.validate({
        JWT_PUBLIC_KEY: validEnv.JWT_PUBLIC_KEY,
      });

      expect(error).toBeUndefined();
      expect(value.UPLOAD_MAX_BYTES).toBe(10_485_760);
    });
  });

  describe('key separation (ADR 004)', () => {
    /**
     * The executable form of the claim "the private key exists only in
     * auth-service". The gateway never validates it, so by the rule "a getter
     * with a default ⟺ a schema with the same default" it must not read it
     * either.
     */
    it('lets the gateway boot without JWT_PRIVATE_KEY', () => {
      const { error } = gatewaySchema.validate({
        JWT_PUBLIC_KEY: validEnv.JWT_PUBLIC_KEY,
      });

      expect(error).toBeUndefined();
    });

    it('does NOT let auth-service boot without JWT_PRIVATE_KEY', () => {
      const { JWT_PRIVATE_KEY: _omitted, ...rest } = validEnv;
      const { error } = authServiceSchema.validate(rest);

      expect(error!.message).toContain('JWT_PRIVATE_KEY');
    });

    it('rejects a key that is not base64-encoded PEM', () => {
      // Raw PEM is the common mistake: it looks right, but dotenv cuts it at
      // the first line break so the service receives a truncated key.
      const { error } = gatewaySchema.validate({ JWT_PUBLIC_KEY: publicKey });

      expect(error).toBeDefined();
      expect(error!.message).toContain('JWT_PUBLIC_KEY');
    });

    it('rejects base64 that does not decode to PEM', () => {
      const { error } = gatewaySchema.validate({
        JWT_PUBLIC_KEY: Buffer.from('not a key').toString('base64'),
      });

      expect(error!.message).toContain('JWT_PUBLIC_KEY');
    });
  });
});
