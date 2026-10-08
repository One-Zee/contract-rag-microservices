import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { extractAuthContext, type UserRoleName } from './auth-context.js';
import { ROLES_KEY } from './roles.decorator.js';
import { rpcForbidden } from '../contracts/rpc-error.js';

/**
 * A role check against the claims, identical in both transports.
 *
 * On the gateway this is the **first** layer — a coarse, cheap check that
 * rejects a request before the network hop. It is never the only one: the
 * service that owns the resource makes the same decision again, plus the
 * ownership check the gateway cannot make because it does not know who the
 * owner is (ADR 006).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRoleName[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }

    const auth = extractAuthContext(context);
    const allowed = auth
      ? required.some((role) => auth.roles.includes(role))
      : false;

    if (!allowed) {
      const message = `Required role: ${required.join(' or ')}`;
      if (context.getType() === 'rpc') {
        throw rpcForbidden(message);
      }
      throw new ForbiddenException(message);
    }
    return true;
  }
}
