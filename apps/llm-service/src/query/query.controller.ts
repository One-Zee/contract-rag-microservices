import { Controller, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { from, type Observable } from 'rxjs';
import {
  CurrentUser,
  LLM_PATTERNS,
  RpcAuthGuard,
  type AskQuestionRpcPayload,
  type AuthContext,
  type CancelQueryRpcPayload,
  type PaginatedQueryHistoryDto,
  type QueryHistoryRpcPayload,
  type QueryStreamEvent,
} from '@app/common';
import { QueryService } from './query.service.js';

/**
 * No `@Roles`: every authenticated role may ask a question. What differs
 * between roles is the corpus, and that is decided in retrieval's SQL — a
 * reader simply has fewer excerpts to be answered from.
 *
 * The guards are on the class so a handler added later cannot forget them.
 */
@Controller()
@UseGuards(RpcAuthGuard)
export class QueryController {
  constructor(private readonly query: QueryService) {}

  /**
   * Returns an Observable rather than a value — the one handler in this repo
   * that does. Nest's TCP transport delivers each emission as its own packet
   * (`Server.send` streams an Observable and marks only the last with
   * `isDisposed`), which is what lets the gateway turn this into SSE without
   * llm-service ever speaking HTTP.
   *
   * `from()` over the async generator: the pipeline is written as sequential
   * code and only becomes a stream here.
   */
  @MessagePattern(LLM_PATTERNS.QUERY)
  ask(
    @Payload() payload: AskQuestionRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Observable<QueryStreamEvent> {
    return from(
      this.query.ask(
        auth,
        {
          question: payload.question,
          documentId: payload.documentId,
          mode: payload.mode,
          limit: payload.limit,
          rerank: payload.rerank,
        },
        // Forwarded so retrieval applies the *caller's* visibility, not this
        // service's. The identity above comes from the verified claims; this
        // is the same token, passed on unopened.
        payload.accessToken,
      ),
    );
  }

  @MessagePattern(LLM_PATTERNS.HISTORY)
  history(
    @Payload() payload: QueryHistoryRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<PaginatedQueryHistoryDto> {
    return this.query.history(auth, payload.page, payload.limit);
  }

  /**
   * What an unsubscribe cannot say. The TCP transport tells the server nothing
   * when a client goes away, so the gateway says it out loud instead.
   */
  @MessagePattern(LLM_PATTERNS.CANCEL)
  cancel(@Payload() payload: CancelQueryRpcPayload): { cancelled: boolean } {
    return { cancelled: this.query.cancel(payload.queryId) };
  }
}
