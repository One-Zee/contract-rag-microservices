import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ABSTAIN_REASONS,
  QUERY_STATUSES,
  type AbstainReason,
  type QueryStatus,
} from '../contracts/query.types.js';
import { SEARCH_MODES, type SearchMode } from '../contracts/search.types.js';

const QUESTION_MAX = 1000;
export const QUERY_LIMIT_MAX = 20;
export const QUERY_HISTORY_LIMIT_MAX = 100;

export class AskQuestionDto {
  @ApiProperty({
    maxLength: QUESTION_MAX,
    example: 'What notice is required to terminate the agreement?',
    description:
      'The question. Retrieved against, then placed in the prompt verbatim.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(QUESTION_MAX)
  question: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Ask about one document; visibility still applies',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional({
    enum: SEARCH_MODES,
    default: 'hybrid',
    description: 'Which retrieval branches run — for the §9.2 comparison',
  })
  @IsOptional()
  @IsIn(SEARCH_MODES)
  mode: SearchMode = 'hybrid';

  @ApiPropertyOptional({
    minimum: 1,
    maximum: QUERY_LIMIT_MAX,
    description:
      'Context chunks to retrieve; defaults to the service QUERY_CONTEXT_CHUNKS. Retrieval may return fewer.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(QUERY_LIMIT_MAX)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Run retrieval’s reranker (or skip it); defaults to whether one is configured',
  })
  @IsOptional()
  // `@Type(() => Boolean)` turns every non-empty string into `true`; a JSON
  // body usually carries a real boolean, but the same endpoint is driven from
  // shell scripts during evaluation, so accept both spellings.
  @Transform(({ value }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  rerank?: boolean;
}

export class QueryHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: QUERY_HISTORY_LIMIT_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(QUERY_HISTORY_LIMIT_MAX)
  limit?: number;
}

/**
 * One context chunk, as the client sees it before any token arrives — enough
 * to render the sources panel while the answer is still being written.
 */
export class QuerySourceDto {
  @ApiProperty({
    description: 'The `[n]` marker this chunk carries in the prompt',
  })
  marker: number;

  @ApiProperty({ format: 'uuid' })
  chunkId: string;

  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty()
  documentTitle: string;

  @ApiPropertyOptional({ nullable: true, description: 'null for DOCX' })
  pageNumber: number | null;

  @ApiPropertyOptional({ nullable: true })
  sectionTitle: string | null;

  @ApiProperty({
    description: 'Cosine similarity, 0 when only the lexical branch found it',
  })
  similarity: number;
}

/** A citation the model actually wrote, once it has been checked against the context. */
export class QueryCitationDto {
  @ApiProperty({ description: 'The `[n]` the model wrote' })
  marker: number;

  @ApiProperty({ format: 'uuid' })
  chunkId: string;

  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty()
  documentTitle: string;

  @ApiPropertyOptional({ nullable: true })
  pageNumber: number | null;

  @ApiPropertyOptional({ nullable: true })
  sectionTitle: string | null;

  @ApiProperty()
  similarity: number;
}

/** Where the time went — the numbers that land in `queries` (plan §9.4). */
export class QueryTimingsDto {
  @ApiProperty({
    description: 'Embedding the question, as retrieval measured it',
  })
  embeddingMs: number;

  @ApiProperty({ description: 'The whole retrieval call, including transport' })
  retrievalMs: number;

  @ApiProperty({ description: '0 when no reranker ran' })
  rerankMs: number;

  @ApiProperty({
    description:
      'First request to last token; 0 when the model was never called',
  })
  llmMs: number;

  @ApiProperty()
  totalMs: number;
}

export class QueryUsageDto {
  @ApiProperty({ description: "The provider's own count, not cl100k_base's" })
  tokensIn: number;

  @ApiProperty()
  tokensOut: number;

  @ApiProperty({
    description:
      'tokens × LLM_COST_*_PER_MTOK — configuration, not a price the API returned',
  })
  estimatedCost: number;
}

/** First event of the stream: everything known before the model is called. */
export class QueryMetaEventDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Also the handle for cancelling this query',
  })
  queryId: string;

  @ApiProperty({ description: 'The question after sanitisation' })
  question: string;

  @ApiProperty({ enum: SEARCH_MODES })
  mode: SearchMode;

  @ApiProperty({
    type: [QuerySourceDto],
    description: 'The chunks placed in the prompt, in prompt order',
  })
  sources: QuerySourceDto[];

  @ApiProperty({ description: 'Name of the model about to be called' })
  model: string;
}

export class QueryTokenEventDto {
  @ApiProperty({
    description:
      'A fragment of the answer; concatenating them all gives `done.answer`',
  })
  text: string;
}

/** Last event of a successful stream. */
export class QueryDoneEventDto {
  @ApiProperty({ format: 'uuid' })
  queryId: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'null when the answer could not be persisted — the text is still valid',
  })
  answerId: string | null;

  @ApiProperty({ description: 'The complete answer, as streamed' })
  answer: string;

  @ApiProperty({ type: [QueryCitationDto] })
  citations: QueryCitationDto[];

  @ApiProperty({
    type: [Number],
    description:
      'Markers the model wrote that were not in the context. Reported, not removed: the text had already been streamed.',
  })
  invalidCitations: number[];

  @ApiProperty({ description: 'True when the system declined to answer' })
  abstained: boolean;

  @ApiPropertyOptional({ enum: ABSTAIN_REASONS, nullable: true })
  abstainReason: AbstainReason | null;

  @ApiProperty({ enum: QUERY_STATUSES })
  status: QueryStatus;

  @ApiProperty()
  model: string;

  @ApiProperty({ type: QueryUsageDto })
  usage: QueryUsageDto;

  @ApiProperty({ type: QueryTimingsDto })
  timings: QueryTimingsDto;
}

/** Takes the place of `done` when generation broke after it had started. */
export class QueryErrorEventDto {
  @ApiProperty({ format: 'uuid' })
  queryId: string;

  @ApiProperty({
    description:
      'The status this would have been, had the failure happened before the first byte',
  })
  statusCode: number;

  @ApiProperty()
  message: string;
}

export class QueryHistoryItemDto {
  @ApiProperty({ format: 'uuid' })
  queryId: string;

  @ApiProperty()
  question: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'null when nothing was ever persisted',
  })
  answer: string | null;

  @ApiProperty({ enum: QUERY_STATUSES })
  status: QueryStatus;

  @ApiProperty()
  abstained: boolean;

  @ApiPropertyOptional({ enum: ABSTAIN_REASONS, nullable: true })
  abstainReason: AbstainReason | null;

  @ApiProperty({ description: 'Citations recorded for the answer' })
  citationCount: number;

  @ApiPropertyOptional({ nullable: true })
  model: string | null;

  @ApiProperty()
  latencyMs: number;

  @ApiProperty()
  createdAt: Date;
}

export class PaginatedQueryHistoryDto {
  @ApiProperty({ type: [QueryHistoryItemDto] })
  items: QueryHistoryItemDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;
}

/**
 * What one TCP emission of `llm.query` carries, and — after the gateway wraps
 * it as `{ type, data }` — one SSE frame. Discriminated on `type` so a handler
 * that forgets a case is a type error rather than a silently dropped frame.
 */
export type QueryStreamEvent =
  | { type: 'meta'; data: QueryMetaEventDto }
  | { type: 'token'; data: QueryTokenEventDto }
  | { type: 'done'; data: QueryDoneEventDto }
  | { type: 'error'; data: QueryErrorEventDto };
