import { Controller, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  type AuthContext,
  CurrentUser,
  RETRIEVAL_PATTERNS,
  RpcAuthGuard,
  type SearchResultsDto,
  type SearchRpcPayload,
} from '@app/common';
import { SearchService } from './search.service.js';

/**
 * No `@Roles`: every authenticated role may search. What differs between roles
 * is the corpus, and that is decided in SQL — a reader simply has fewer chunks
 * to match against.
 */
@Controller()
@UseGuards(RpcAuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @MessagePattern(RETRIEVAL_PATTERNS.SEARCH)
  run(
    @Payload() payload: SearchRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<SearchResultsDto> {
    return this.search.search(auth, {
      query: payload.query,
      mode: payload.mode,
      limit: payload.limit,
      documentId: payload.documentId,
      rerank: payload.rerank,
    });
  }
}
