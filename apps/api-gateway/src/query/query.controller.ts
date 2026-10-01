import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Query,
  RequestMethod,
  Sse,
  SseSignal,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  firstValueFrom,
  lastValueFrom,
  map,
  shareReplay,
  tap,
  type Observable,
} from 'rxjs';
import {
  AskQuestionDto,
  LLM_PATTERNS,
  PaginatedQueryHistoryDto,
  QueryHistoryQueryDto,
  type AskQuestionRpcPayload,
  type CancelQueryRpcPayload,
  type QueryHistoryRpcPayload,
  type QueryStreamEvent,
} from '@app/common';
import { AccessToken } from '../auth/access-token.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { LLM_CLIENT } from '../clients/llm-client.module.js';
import { rpcToHttp } from '../common/rpc-to-http.js';

@ApiTags('query')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('query')
export class QueryController {
  constructor(@Inject(LLM_CLIENT) private readonly llm: ClientProxy) {}

  /** SSE stream`.
   *
   * Two pieces of machinery are worth explaining, because neither is obvious:
   *
   * **`@Sse` on a POST.** `@Sse()` defaults to GET, but takes the method as an
   * option. POST is what the plan specifies and what the shape of the request
   * wants — a question with a document filter is a body, not a query string.
   * `@HttpCode` is then required: Nest picks the status from the method before
   * the handler runs, so without it every answer would be a 201.
   *
   * **Awaiting the first event.** Nest commits the SSE headers one macrotask
   * after the handler returns (`RouterResponseController.sse`), not on the
   * first message — so anything that fails asynchronously after that point can
   * no longer be an HTTP status, only an in-band `error` event on a 200. By
   * awaiting the stream's first emission here, everything that is legitimately
   * an HTTP failure — no token, a malformed body, llm-service unreachable,
   * retrieval refusing — still gets its real status and a JSON body. Only a
   * failure *during generation* degrades to an event, which is correct: by
   * then the user is already reading the answer.
   *
   * `shareReplay` is what makes that lossless. `ClientProxy.send` is cold, so
   * the stream is subscribed once here and replayed to Nest afterwards;
   * without the replay buffer, every token emitted between the await and
   * Nest's own subscribe would be dropped.
   */
  @Sse('', { [METHOD_METADATA]: RequestMethod.POST })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask a question about the corpus; the answer streams back as SSE',
    description:
      'Emits one `meta` event (query id and the excerpts that went into the prompt), ' +
      'then one `token` event per fragment of the answer, then one `done` event ' +
      '(full text, validated citations, usage and timings). A failure after ' +
      'generation has started arrives as an `error` event instead of `done`, on ' +
      'the already-sent 200.',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({ status: 200, description: 'The answer stream' })
  @ApiResponse({
    status: 400,
    description: 'No question, or an invalid parameter',
  })
  @ApiResponse({ status: 401, description: 'No or invalid token' })
  @ApiResponse({ status: 503, description: 'llm-service is unreachable' })
  async ask(
    @Body() body: AskQuestionDto,
    @AccessToken() accessToken: string,
    @SseSignal() signal: AbortSignal,
  ): Promise<Observable<MessageEvent>> {
    let queryId: string | null = null;
    let finished = false;

    const stream = this.llm
      .send<QueryStreamEvent>(LLM_PATTERNS.QUERY, {
        accessToken,
        question: body.question,
        documentId: body.documentId,
        mode: body.mode,
        limit: body.limit,
        rerank: body.rerank,
      } satisfies AskQuestionRpcPayload)
      .pipe(
        tap({
          next: (event) => {
            if (event.type === 'meta') {
              queryId = event.data.queryId;
            }
          },
          complete: () => {
            finished = true;
          },
          error: () => {
            finished = true;
          },
        }),
        shareReplay({ bufferSize: Number.POSITIVE_INFINITY, refCount: false }),
      );

    // Starts the request now, so nothing is lost before Nest subscribes. The
    // error is swallowed here and re-raised through the awaited promise below,
    // which is the one the exception filter can still act on.
    const upstream = stream.subscribe({ error: () => undefined });

    try {
      await firstValueFrom(stream.pipe(rpcToHttp('llm')));
    } catch (error) {
      upstream.unsubscribe();
      throw error;
    }

    // The signal aborts on *every* exit, completion included, so cancelling is
    // gated on the stream not having finished. Without this the gateway would
    // send a pointless cancel after every successful answer.
    signal.addEventListener(
      'abort',
      () => {
        upstream.unsubscribe();
        if (!finished && queryId) {
          this.cancel(queryId, accessToken);
        }
      },
      { once: true },
    );

    return stream.pipe(map(toMessageEvent));
  }

  @Get('history')
  @ApiOperation({ summary: 'The questions this user has asked, newest first' })
  @ApiResponse({ status: 200, type: PaginatedQueryHistoryDto })
  @ApiResponse({ status: 401, description: 'No or invalid token' })
  @ApiResponse({ status: 503, description: 'llm-service is unreachable' })
  history(
    @Query() query: QueryHistoryQueryDto,
    @AccessToken() accessToken: string,
  ): Observable<PaginatedQueryHistoryDto> {
    return this.llm
      .send<PaginatedQueryHistoryDto>(LLM_PATTERNS.HISTORY, {
        accessToken,
        page: query.page,
        limit: query.limit ?? 20,
      } satisfies QueryHistoryRpcPayload)
      .pipe(rpcToHttp('llm'));
  }

  /**
   * Tells llm-service to stop generating. Fire and forget on purpose: the
   * client is already gone, so there is nobody to report a failed cancel to —
   * it is logged and that is all.
   */
  private cancel(queryId: string, accessToken: string): void {
    void lastValueFrom(
      this.llm.send<{ cancelled: boolean }>(LLM_PATTERNS.CANCEL, {
        accessToken,
        queryId,
      } satisfies CancelQueryRpcPayload),
    ).catch(() => undefined);
  }
}

/**
 * `{ type, data }` is exactly what Nest's `SseStream` wants: `type` becomes the
 * `event:` line and `data` is JSON-encoded onto `data:`.
 */
const toMessageEvent = (event: QueryStreamEvent): MessageEvent => ({
  type: event.type,
  data: event.data,
});
