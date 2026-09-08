import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnvironment } from './enums/app-environment.enum.js';
import type { LlmProvider } from './schemas/llm.schema.js';

/**
 * Tipizirano čitanje env varijabli. Nijedan servis ne smije zvati `ConfigService`
 * direktno niti dirati `process.env` — sve ide kroz ove getere.
 *
 * Pravilo koje se drži bez izuzetka: **getter s defaultom ⟺ šema s istim defaultom.**
 * Varijabla koja je u šemi `.required()` čita se kroz `getOrThrow`, pa ako je servis
 * nije validirao (nije uključio taj fragment u svoju šemu), poziv pukne odmah i glasno
 * umjesto da vrati `undefined` sakriven iza `!`.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  // ── Runtime okruženje ──────────────────────────────────────────────────────
  get nodeEnv(): AppEnvironment {
    return this.configService.get<AppEnvironment>(
      'NODE_ENV',
      AppEnvironment.DEVELOPMENT,
    );
  }

  get isProduction(): boolean {
    return this.nodeEnv === AppEnvironment.PRODUCTION;
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === AppEnvironment.DEVELOPMENT;
  }

  get isTest(): boolean {
    return this.nodeEnv === AppEnvironment.TEST;
  }

  // ── Portovi (svi imaju default u baseSchema) ───────────────────────────────
  get gatewayPort(): number {
    return this.configService.get<number>('GATEWAY_PORT', 3000);
  }

  get authPort(): number {
    return this.configService.get<number>('AUTH_PORT', 3001);
  }

  get ingestionPort(): number {
    return this.configService.get<number>('INGESTION_PORT', 3002);
  }

  get indexingPort(): number {
    return this.configService.get<number>('INDEXING_PORT', 3003);
  }

  get retrievalPort(): number {
    return this.configService.get<number>('RETRIEVAL_PORT', 3004);
  }

  get llmPort(): number {
    return this.configService.get<number>('LLM_PORT', 3005);
  }

  // ── Baza ───────────────────────────────────────────────────────────────────
  get databaseUrl(): string {
    return this.configService.getOrThrow<string>('DATABASE_URL');
  }

  // ── Messaging ──────────────────────────────────────────────────────────────
  get rabbitmqUrl(): string {
    return this.configService.getOrThrow<string>('RABBITMQ_URL');
  }

  get redisUrl(): string {
    return this.configService.getOrThrow<string>('REDIS_URL');
  }

  // ── Skladište objekata (MinIO / S3) ────────────────────────────────────────
  get s3Endpoint(): string {
    return this.configService.getOrThrow<string>('S3_ENDPOINT');
  }

  get s3AccessKey(): string {
    return this.configService.getOrThrow<string>('S3_ACCESS_KEY');
  }

  get s3SecretKey(): string {
    return this.configService.getOrThrow<string>('S3_SECRET_KEY');
  }

  get s3Bucket(): string {
    return this.configService.getOrThrow<string>('S3_BUCKET');
  }

  // ── Autentikacija ──────────────────────────────────────────────────────────
  get jwtSecret(): string {
    return this.configService.getOrThrow<string>('JWT_SECRET');
  }

  get jwtExpiresIn(): string {
    return this.configService.get<string>('JWT_EXPIRES_IN', '15m');
  }

  get refreshExpiresIn(): string {
    return this.configService.get<string>('REFRESH_EXPIRES_IN', '7d');
  }

  // ── AI sloj ────────────────────────────────────────────────────────────────
  get llmProvider(): LlmProvider {
    return this.configService.get<LlmProvider>('LLM_PROVIDER', 'ollama');
  }

  get embeddingDimensions(): number {
    return this.configService.get<number>('EMBEDDING_DIMENSIONS', 1024);
  }
}
