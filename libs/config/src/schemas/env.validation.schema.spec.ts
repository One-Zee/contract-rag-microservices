import { generateKeyPairSync } from 'node:crypto';
import type { ObjectSchema } from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';
import { authSchema, authSigningSchema } from './auth.schema.js';
import { baseSchema } from './base.schema.js';
import { chunkingSchema } from './chunking.schema.js';
import { databaseSchema } from './database.schema.js';
import { llmSchema } from './llm.schema.js';
import { messagingSchema } from './messaging.schema.js';
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

  it('locks EMBEDDING_DIMENSIONS to 1024 (vector(1024) in migration 0001)', () => {
    const schema = withOptions(baseSchema.concat(llmSchema));

    expect(schema.validate({ EMBEDDING_DIMENSIONS: 768 }).error).toBeDefined();
    expect(
      schema.validate({ EMBEDDING_DIMENSIONS: 1024 }).error,
    ).toBeUndefined();
    expect(schema.validate({}).value.EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it('lets llm-service boot without DATABASE_URL', () => {
    const schema = withOptions(baseSchema.concat(llmSchema));

    expect(schema.validate({}).error).toBeUndefined();
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
