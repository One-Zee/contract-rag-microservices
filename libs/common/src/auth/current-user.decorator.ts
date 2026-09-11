import {
  ExecutionContext,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { AuthContext, extractAuthContext } from './auth-context.js';
import { rpcUnauthorized } from '../contracts/rpc-error.js';

/**
 * `@CurrentUser()` returns the whole context, `@CurrentUser('userId')` a single
 * field. Works in both an HTTP controller and a `@MessagePattern` handler.
 *
 * A missing context means the route was left without a guard — a configuration
 * bug, not a bad request. It fails loudly rather than returning `undefined`,
 * which business code could read as "no owner, therefore allowed".
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthContext | undefined, context: ExecutionContext) => {
    const auth = extractAuthContext(context);
    if (!auth) {
      if (context.getType() === 'rpc') {
        throw rpcUnauthorized('Missing authenticated context');
      }
      throw new UnauthorizedException('Missing authenticated context');
    }
    return field ? auth[field] : auth;
  },
);
