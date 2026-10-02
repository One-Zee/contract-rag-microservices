import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { AppConfigService } from '@app/config';

const STRICT_THROTTLE = 'clauseiq:strict-throttle';

/**
 * Puts a handler under the `strict` budget as well as the general one — for
 * routes that cost something to answer: a bcrypt hash, a model call.
 *
 * Opt-in on purpose: a new route gets the general budget and never the strict
 * one by accident.
 */
export const StrictThrottle = () => SetMetadata(STRICT_THROTTLE, true);

/**
 * Two budgets per client address over the same window.
 *
 * `THROTTLE_ENABLED` is checked inside each throttler's own `skipIf`, because
 * a throttler that has one ignores the module-wide `skipIf` — the strict
 * throttler would otherwise keep counting with throttling turned off.
 */
export function createThrottlerOptions(
  config: AppConfigService,
): ThrottlerModuleOptions {
  const reflector = new Reflector();
  const disabled = !config.throttleEnabled;
  const isStrict = (context: ExecutionContext): boolean =>
    reflector.getAllAndOverride<boolean>(STRICT_THROTTLE, [
      context.getHandler(),
      context.getClass(),
    ]) === true;

  return {
    throttlers: [
      {
        name: 'default',
        ttl: config.throttleTtlMs,
        limit: config.throttleLimit,
        skipIf: () => disabled,
      },
      {
        name: 'strict',
        ttl: config.throttleTtlMs,
        limit: config.throttleStrictLimit,
        skipIf: (context) => disabled || !isStrict(context),
      },
    ],
  };
}
