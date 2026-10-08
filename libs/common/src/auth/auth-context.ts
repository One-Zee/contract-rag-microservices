import type { ExecutionContext } from '@nestjs/common';

/**
 * The roles of the `user_role` enum in the database.
 *
 * The literal is deliberately **duplicated** here instead of imported from
 * `@app/database`: `drizzle.config.ts` loads
 * `libs/database/src/schema/index.ts` through its own bundler, which does not
 * resolve `@app/*` aliases, so the import would break `db:generate`. A test in
 * `libs/database/src/schema/users.spec.ts` guards against the two drifting apart.
 */
export const USER_ROLES = ['admin', 'analyst', 'reader'] as const;
export type UserRoleName = (typeof USER_ROLES)[number];

/** Access token claims. Everything but `sub`/`email`/`roles` is set by `jsonwebtoken`. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  roles: UserRoleName[];
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface AuthContext {
  userId: string;
  email: string;
  roles: UserRoleName[];
  permissions?: string[];
}

export const toAuthContext = (claims: AccessTokenPayload): AuthContext => ({
  userId: claims.sub,
  email: claims.email,
  roles: claims.roles,
});

/**
 * The key under which `RpcAuthGuard` attaches the context to a TCP payload.
 */
export const AUTH_CONTEXT = Symbol.for('clauseiq.auth.context');

/** A TCP payload once the guard has enriched it. */
export type WithAuthContext<T> = T & { [AUTH_CONTEXT]?: AuthContext };

/**
 * One place that knows where the context lives in each transport:
 * `request.user` for HTTP (where Passport puts it), the symbol on the payload
 * for RPC. Both `RolesGuard` and `@CurrentUser()` use it, so the two cannot
 * disagree.
 */
export function extractAuthContext(
  ctx: ExecutionContext,
): AuthContext | undefined {
  if (ctx.getType() === 'rpc') {
    const data = ctx.switchToRpc().getData<WithAuthContext<object>>();
    return data?.[AUTH_CONTEXT];
  }
  return ctx.switchToHttp().getRequest<{ user?: AuthContext }>()?.user;
}
