import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  DOCUMENT_STATUSES,
  DOCUMENT_VISIBILITIES,
  type DocumentStatus,
  type DocumentVisibility,
} from '../contracts/document.types.js';

const TITLE_MAX = 200;
export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 100;

/** Text fields of the multipart upload; the file itself travels as `file`. */
export class UploadDocumentDto {
  @ApiPropertyOptional({
    maxLength: TITLE_MAX,
    description: 'Defaults to the file name without its extension',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(TITLE_MAX)
  title?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_VISIBILITIES, default: 'private' })
  @IsOptional()
  @IsIn(DOCUMENT_VISIBILITIES)
  visibility?: DocumentVisibility;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ maxLength: TITLE_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(TITLE_MAX)
  title?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_VISIBILITIES })
  @IsOptional()
  @IsIn(DOCUMENT_VISIBILITIES)
  visibility?: DocumentVisibility;
}

export class ListDocumentsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LIST_LIMIT_MAX,
    default: LIST_LIMIT_DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIST_LIMIT_MAX)
  limit: number = LIST_LIMIT_DEFAULT;

  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES })
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES)
  status?: DocumentStatus;
}

export class DocumentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  originalFilename: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType: string;

  @ApiProperty({ description: 'Bytes' })
  fileSize: number;

  @ApiProperty({ enum: DOCUMENT_STATUSES })
  status: DocumentStatus;

  @ApiProperty({ enum: DOCUMENT_VISIBILITIES })
  visibility: DocumentVisibility;

  @ApiPropertyOptional({ nullable: true, description: 'null for DOCX' })
  pageCount: number | null;

  @ApiProperty({ format: 'uuid' })
  uploadedBy: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Set when status is `failed`',
  })
  errorMessage: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

/** The polling view: what a client needs to follow one document through the pipeline. */
export class DocumentStatusDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: DOCUMENT_STATUSES })
  status: DocumentStatus;

  @ApiPropertyOptional({ nullable: true })
  pageCount: number | null;

  @ApiProperty({ description: '0 until the document reaches `chunked`' })
  chunkCount: number;

  @ApiPropertyOptional({ nullable: true })
  errorMessage: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class PaginatedDocumentsDto {
  @ApiProperty({ type: [DocumentDto] })
  items: DocumentDto[];

  @ApiProperty({ description: 'Documents visible to the caller after filters' })
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;
}
