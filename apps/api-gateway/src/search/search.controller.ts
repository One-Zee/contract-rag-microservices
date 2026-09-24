import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import {
  RETRIEVAL_PATTERNS,
  SearchQueryDto,
  SearchResultsDto,
  type SearchRpcPayload,
} from '@app/common';
import { AccessToken } from '../auth/access-token.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RETRIEVAL_CLIENT } from '../clients/retrieval-client.module.js';
import { rpcToHttp } from '../common/rpc-to-http.js';

/**
 * Search without an LLM in the way. It exists for the evaluation in plan §9.2
 * — the four configurations are four values of `mode` and `rerank` — and it is
 * the endpoint that proves the retrieval half works before phase 5 puts a
 * model behind it.
 *
 * No `@Roles`: anyone signed in may search, and retrieval-service decides in
 * SQL whose chunks they are allowed to match against.
 */
@ApiTags('search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(
    @Inject(RETRIEVAL_CLIENT) private readonly retrieval: ClientProxy,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Hybrid search over the indexed corpus — vector + full-text, fused with RRF',
  })
  @ApiResponse({ status: 200, type: SearchResultsDto })
  @ApiResponse({
    status: 400,
    description: 'No question, or an invalid parameter',
  })
  @ApiResponse({ status: 401, description: 'No or invalid token' })
  @ApiResponse({ status: 503, description: 'retrieval-service is unreachable' })
  search(
    @Query() query: SearchQueryDto,
    @AccessToken() accessToken: string,
  ): Observable<SearchResultsDto> {
    return this.retrieval
      .send<SearchResultsDto>(RETRIEVAL_PATTERNS.SEARCH, {
        accessToken,
        query: query.q,
        mode: query.mode,
        limit: query.limit,
        documentId: query.documentId,
        rerank: query.rerank,
      } satisfies SearchRpcPayload)
      .pipe(rpcToHttp('retrieval'));
  }
}
