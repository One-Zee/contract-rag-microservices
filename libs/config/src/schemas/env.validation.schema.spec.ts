import type { ObjectSchema } from 'joi';
import { AppEnvironment } from '../enums/app-environment.enum.js';
import { authSchema } from './auth.schema.js';
import { baseSchema } from './base.schema.js';
import { databaseSchema } from './database.schema.js';
import { llmSchema } from './llm.schema.js';

/**
 * Iste opcije koje AppConfigModule.forRoot postavlja centralno. Bez njih Joi
 * odbija nepoznate ključeve i prijavljuje samo prvu grešku, pa bi testovi
 * mjerili nešto što se u aplikaciji nikad ne dešava.
 */
const withOptions = (schema: ObjectSchema): ObjectSchema =>
  schema.options({ abortEarly: false, allowUnknown: true });

const validEnv = {
  DATABASE_URL: 'postgresql://app:dev@localhost:5432/contracts',
  JWT_SECRET: 'x'.repeat(32),
};

describe('env validation schemas', () => {
  const authServiceSchema = withOptions(
    baseSchema.concat(authSchema).concat(databaseSchema),
  );

  it('prolazi na validnom okruženju i primjenjuje defaulte', () => {
    const { error, value } = authServiceSchema.validate(validEnv);

    expect(error).toBeUndefined();
    expect(value.NODE_ENV).toBe(AppEnvironment.DEVELOPMENT);
    expect(value.AUTH_PORT).toBe(3001);
    expect(value.JWT_EXPIRES_IN).toBe('15m');
  });

  it('odbija okruženje bez DATABASE_URL i imenuje varijablu', () => {
    const { error } = authServiceSchema.validate({
      JWT_SECRET: validEnv.JWT_SECRET,
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('DATABASE_URL');
  });

  it('prijavljuje sve greške odjednom (abortEarly: false)', () => {
    const { error } = authServiceSchema.validate({});

    expect(error!.details).toHaveLength(2);
    expect(error!.message).toContain('DATABASE_URL');
    expect(error!.message).toContain('JWT_SECRET');
  });

  it('odbija DATABASE_URL koji nije postgres URI', () => {
    const { error } = authServiceSchema.validate({
      ...validEnv,
      DATABASE_URL: 'not-a-url',
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain('DATABASE_URL');
  });

  it('odbija prekratak JWT_SECRET', () => {
    const { error } = authServiceSchema.validate({
      ...validEnv,
      JWT_SECRET: 'prekratko',
    });

    expect(error!.message).toContain('JWT_SECRET');
  });

  it('tolerira varijable koje servis ne koristi (allowUnknown)', () => {
    const { error } = authServiceSchema.validate({
      ...validEnv,
      S3_BUCKET: 'contracts',
      RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
    });

    expect(error).toBeUndefined();
  });

  it('zaključava EMBEDDING_DIMENSIONS na 1024 (vector(1024) u migraciji 0001)', () => {
    const schema = withOptions(baseSchema.concat(llmSchema));

    expect(schema.validate({ EMBEDDING_DIMENSIONS: 768 }).error).toBeDefined();
    expect(
      schema.validate({ EMBEDDING_DIMENSIONS: 1024 }).error,
    ).toBeUndefined();
    expect(schema.validate({}).value.EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it('llm-service se diže bez DATABASE_URL', () => {
    const schema = withOptions(baseSchema.concat(llmSchema));

    expect(schema.validate({}).error).toBeUndefined();
  });
});
