import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnvironment } from './enums/app-environment.enum.js';
import type { EmbeddingProviderName } from './schemas/embeddings.schema.js';
import type { LlmProvider } from './schemas/llm.schema.js';
import type {
  LexicalMatch,
  RerankProviderName,
} from './schemas/retrieval.schema.js';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  // ── Runtime environment ────────────────────────────────────────────────────
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

  // ── Ports (all defaulted in baseSchema) ────────────────────────────────────
  get gatewayPort(): number {
    return this.configService.get<number>('GATEWAY_PORT', 3000);
  }

  get authPort(): number {
    return this.configService.get<number>('AUTH_PORT', 3001);
  }

  get authHost(): string {
    return this.configService.get<string>('AUTH_HOST', '127.0.0.1');
  }

  get ingestionHost(): string {
    return this.configService.get<string>('INGESTION_HOST', '127.0.0.1');
  }

  get ingestionPort(): number {
    return this.configService.get<number>('INGESTION_PORT', 3002);
  }

  get indexingPort(): number {
    return this.configService.get<number>('INDEXING_PORT', 3003);
  }

  get retrievalHost(): string {
    return this.configService.get<string>('RETRIEVAL_HOST', '127.0.0.1');
  }

  get retrievalPort(): number {
    return this.configService.get<number>('RETRIEVAL_PORT', 3004);
  }

  get llmHost(): string {
    return this.configService.get<string>('LLM_HOST', '127.0.0.1');
  }

  get llmPort(): number {
    return this.configService.get<number>('LLM_PORT', 3005);
  }

  // ── Database ───────────────────────────────────────────────────────────────
  get databaseUrl(): string {
    return this.configService.getOrThrow<string>('DATABASE_URL');
  }

  // ── Messaging ──────────────────────────────────────────────────────────────
  get rabbitmqUrl(): string {
    return this.configService.getOrThrow<string>('RABBITMQ_URL');
  }

  // ── Cache ──────────────────────────────────────────────────────────────────
  get redisUrl(): string {
    return this.configService.getOrThrow<string>('REDIS_URL');
  }

  // ── Object storage (MinIO / S3) ────────────────────────────────────────────
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

  get s3Region(): string {
    return this.configService.get<string>('S3_REGION', 'us-east-1');
  }

  get s3ForcePathStyle(): boolean {
    return this.configService.get<boolean>('S3_FORCE_PATH_STYLE', true);
  }

  // ── Upload and segmentation ────────────────────────────────────────────────
  get uploadMaxBytes(): number {
    return this.configService.get<number>('UPLOAD_MAX_BYTES', 10_485_760);
  }

  get chunkSizeTokens(): number {
    return this.configService.get<number>('CHUNK_SIZE_TOKENS', 800);
  }

  get chunkOverlapTokens(): number {
    return this.configService.get<number>('CHUNK_OVERLAP_TOKENS', 120);
  }

  get chunkRespectSections(): boolean {
    return this.configService.get<boolean>('CHUNK_RESPECT_SECTIONS', true);
  }

  get ingestionConcurrency(): number {
    return this.configService.get<number>('INGESTION_CONCURRENCY', 2);
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  /**
   * Verification key — read by the gateway and every protected service. The
   * environment holds base64(PEM); see the comment in `auth.schema.ts`.
   */
  get jwtPublicKey(): string {
    return this.decodePem('JWT_PUBLIC_KEY');
  }

  /**
   * Signing key. Only `authSigningSchema` validates it, and only `auth-service`
   * composes that fragment — so if anything else calls this getter, `getOrThrow`
   * fails immediately instead of handing back `undefined`.
   */
  get jwtPrivateKey(): string {
    return this.decodePem('JWT_PRIVATE_KEY');
  }

  get jwtIssuer(): string {
    return this.configService.get<string>('JWT_ISSUER', 'clauseiq-auth');
  }

  get jwtAudience(): string {
    return this.configService.get<string>('JWT_AUDIENCE', 'clauseiq-api');
  }

  get jwtExpiresIn(): string {
    return this.configService.get<string>('JWT_EXPIRES_IN', '15m');
  }

  get refreshExpiresIn(): string {
    return this.configService.get<string>('REFRESH_EXPIRES_IN', '7d');
  }

  get registrationEnabled(): boolean {
    return this.configService.get<boolean>('AUTH_REGISTRATION_ENABLED', true);
  }

  private decodePem(key: string): string {
    return Buffer.from(
      this.configService.getOrThrow<string>(key),
      'base64',
    ).toString('utf8');
  }

  // ── Rate limiting (gateway) ────────────────────────────────────────────────
  get throttleEnabled(): boolean {
    return this.configService.get<boolean>('THROTTLE_ENABLED', true);
  }

  get throttleTtlMs(): number {
    return this.configService.get<number>('THROTTLE_TTL_MS', 60_000);
  }

  get throttleLimit(): number {
    return this.configService.get<number>('THROTTLE_LIMIT', 120);
  }

  get throttleStrictLimit(): number {
    return this.configService.get<number>('THROTTLE_STRICT_LIMIT', 10);
  }

  // ── AI layer ───────────────────────────────────────────────────────────────
  get llmProvider(): LlmProvider {
    return this.configService.get<LlmProvider>('LLM_PROVIDER', 'ollama');
  }

  get llmModel(): string {
    return this.configService.getOrThrow<string>('LLM_MODEL');
  }

  /** Required by the schema whenever the provider is `anthropic`, hence no default. */
  get anthropicApiKey(): string {
    return this.configService.getOrThrow<string>('ANTHROPIC_API_KEY');
  }

  get anthropicVersion(): string {
    return this.configService.get<string>('ANTHROPIC_VERSION', '2023-06-01');
  }

  /** `undefined` means the real API. */
  get anthropicBaseUrl(): string | undefined {
    return this.configService.get<string>('ANTHROPIC_BASE_URL');
  }

  get ollamaBaseUrl(): string {
    return this.configService.get<string>(
      'OLLAMA_BASE_URL',
      'http://127.0.0.1:11434',
    );
  }

  get llmMaxTokens(): number {
    return this.configService.get<number>('LLM_MAX_TOKENS', 1024);
  }

  /** `undefined` means "do not send the field" — not every model accepts it. */
  get llmTemperature(): number | undefined {
    return this.configService.get<number>('LLM_TEMPERATURE');
  }

  get llmIdleTimeoutMs(): number {
    return this.configService.get<number>('LLM_IDLE_TIMEOUT_MS', 60_000);
  }

  get llmCostInputPerMTok(): number {
    return this.configService.get<number>('LLM_COST_INPUT_PER_MTOK', 0);
  }

  get llmCostOutputPerMTok(): number {
    return this.configService.get<number>('LLM_COST_OUTPUT_PER_MTOK', 0);
  }

  // ── Query pipeline ─────────────────────────────────────────────────────────
  get queryContextChunks(): number {
    return this.configService.get<number>('QUERY_CONTEXT_CHUNKS', 5);
  }

  get queryMinSimilarity(): number {
    return this.configService.get<number>('QUERY_MIN_SIMILARITY', 0);
  }

  get queryContextMaxTokens(): number {
    return this.configService.get<number>('QUERY_CONTEXT_MAX_TOKENS', 6000);
  }

  get queryHistoryPageSize(): number {
    return this.configService.get<number>('QUERY_HISTORY_PAGE_SIZE', 20);
  }

  get embeddingProvider(): EmbeddingProviderName {
    return this.configService.get<EmbeddingProviderName>(
      'EMBEDDING_PROVIDER',
      'voyage',
    );
  }

  get embeddingModel(): string {
    return this.configService.get<string>('EMBEDDING_MODEL', 'voyage-law-2');
  }

  get embeddingDimensions(): number {
    return this.configService.get<number>('EMBEDDING_DIMENSIONS', 1024);
  }

  get embeddingBatchSize(): number {
    return this.configService.get<number>('EMBEDDING_BATCH_SIZE', 100);
  }

  /** Required by the schema whenever the provider is `voyage`, hence no default. */
  get voyageApiKey(): string {
    return this.configService.getOrThrow<string>('VOYAGE_API_KEY');
  }

  /** `undefined` means the real API. */
  get voyageBaseUrl(): string | undefined {
    return this.configService.get<string>('VOYAGE_BASE_URL');
  }

  // ── Hybrid search ──────────────────────────────────────────────────────────
  get searchCandidates(): number {
    return this.configService.get<number>('SEARCH_CANDIDATES', 20);
  }

  get searchFused(): number {
    return this.configService.get<number>('SEARCH_FUSED', 10);
  }

  get searchTopK(): number {
    return this.configService.get<number>('SEARCH_TOP_K', 5);
  }

  get rrfK(): number {
    return this.configService.get<number>('RRF_K', 60);
  }

  get hnswEfSearch(): number {
    return this.configService.get<number>('HNSW_EF_SEARCH', 100);
  }

  get lexicalMatch(): LexicalMatch {
    return this.configService.get<LexicalMatch>('LEXICAL_MATCH', 'all');
  }

  get rerankProvider(): RerankProviderName {
    return this.configService.get<RerankProviderName>(
      'RERANK_PROVIDER',
      'none',
    );
  }

  get rerankModel(): string {
    return this.configService.get<string>('RERANK_MODEL', 'rerank-v3.5');
  }

  /** Required by the schema whenever the provider is `cohere`, hence no default. */
  get cohereApiKey(): string {
    return this.configService.getOrThrow<string>('COHERE_API_KEY');
  }

  /** `undefined` means the real API. */
  get cohereBaseUrl(): string | undefined {
    return this.configService.get<string>('COHERE_BASE_URL');
  }
}
