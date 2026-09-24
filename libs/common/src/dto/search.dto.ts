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
import { SEARCH_MODES, type SearchMode } from '../contracts/search.types.js';

const QUERY_MAX = 500;
export const SEARCH_LIMIT_MAX = 50;

export class SearchQueryDto {
  @ApiProperty({
    maxLength: QUERY_MAX,
    example: 'What notice is required to terminate the agreement?',
    description: 'The question. Embedded as a vector and parsed as a tsquery.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(QUERY_MAX)
  q: string;

  @ApiPropertyOptional({
    enum: SEARCH_MODES,
    default: 'hybrid',
    description:
      'Which branches run — `vector` and `lexical` exist for evaluation',
  })
  @IsOptional()
  @IsIn(SEARCH_MODES)
  mode: SearchMode = 'hybrid';

  @ApiPropertyOptional({
    minimum: 1,
    maximum: SEARCH_LIMIT_MAX,
    description: 'Results to return; defaults to the service SEARCH_TOP_K',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEARCH_LIMIT_MAX)
  limit?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Search inside one document; visibility still applies',
  })
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @ApiPropertyOptional({
    description:
      'Run the reranker (or skip it); defaults to whether one is configured',
  })
  @IsOptional()
  // `@Type(() => Boolean)` turns every non-empty string into `true`, so
  // `rerank=false` would switch reranking on. A query string carries text.
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

/** One chunk, with everything a citation needs to point back at the document. */
export class SearchResultDto {
  @ApiProperty({ format: 'uuid' })
  chunkId: string;

  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty()
  documentTitle: string;

  @ApiProperty({ description: 'Position of the chunk inside the document' })
  chunkIndex: number;

  @ApiProperty()
  content: string;

  @ApiPropertyOptional({ nullable: true, description: 'null for DOCX' })
  pageNumber: number | null;

  @ApiPropertyOptional({ nullable: true })
  sectionTitle: string | null;

  @ApiProperty({
    description:
      'The reranker score when one ran, otherwise the RRF score — always the value this list is sorted by',
  })
  score: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '1-based rank in the vector branch, null if it was not found there',
  })
  vectorRank: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '1-based rank in the lexical branch, null if it was not found there',
  })
  lexicalRank: number | null;

  @ApiProperty({
    description: 'Cosine similarity, 0 when only the lexical branch found it',
  })
  similarity: number;
}

/** Where the time went — the numbers phase 5 stores in `queries`. */
export class SearchTimingsDto {
  @ApiProperty({ description: 'Embedding the question' })
  embeddingMs: number;

  @ApiProperty()
  vectorMs: number;

  @ApiProperty()
  lexicalMs: number;

  @ApiProperty({ description: '0 when no reranker ran' })
  rerankMs: number;

  @ApiProperty()
  totalMs: number;
}

/** How many candidates each branch contributed before fusion. */
export class SearchCandidatesDto {
  @ApiProperty()
  vector: number;

  @ApiProperty()
  lexical: number;

  @ApiProperty({ description: 'Distinct chunks after RRF fusion' })
  fused: number;
}

export class SearchResultsDto {
  @ApiProperty({ description: 'The question as it was searched' })
  query: string;

  @ApiProperty({ enum: SEARCH_MODES })
  mode: SearchMode;

  @ApiProperty({
    description: 'Name of the reranker that ran, `none` if none did',
  })
  reranker: string;

  @ApiProperty({ type: [SearchResultDto] })
  results: SearchResultDto[];

  @ApiProperty({ type: SearchCandidatesDto })
  candidates: SearchCandidatesDto;

  @ApiProperty({ type: SearchTimingsDto })
  timings: SearchTimingsDto;
}
