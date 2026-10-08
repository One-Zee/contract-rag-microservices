import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * `ThrottlerGuard` that only ever looks at HTTP requests.
 *
 * Registered as `APP_GUARD`, so it runs before `JwtAuthGuard` and before any
 * handler: a 429 is a real status even on `POST /query`, whose response is
 * otherwise committed as a stream. In the monolith the same module
 * shares a process with RPC handlers, where there is no request to count —
 * the base guard would read `undefined` as one.
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected override async shouldSkip(
    context: ExecutionContext,
  ): Promise<boolean> {
    return context.getType() !== 'http';
  }
}
