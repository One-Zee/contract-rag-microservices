import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AUTH_CONTEXT,
  AccessTokenPayload,
  WithAuthContext,
  toAuthContext,
} from './auth-context.js';
import type { AuthenticatedRpcPayload } from '../contracts/auth.patterns.js';
import { rpcUnauthorized } from '../contracts/rpc-error.js';

/**
 * The second layer of defence (OWASP defence in depth): the service verifies
 * the token the gateway forwarded **again**, rather than assuming the gateway
 * already did.
 */
@Injectable()
export class RpcAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const payload = context
      .switchToRpc()
      .getData<WithAuthContext<Partial<AuthenticatedRpcPayload>>>();

    const token = payload?.accessToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw rpcUnauthorized('Missing access token in RPC call');
    }

    let claims: AccessTokenPayload;
    try {
      claims = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      // Deliberately no detail about the cause: expired, forged and wrong `aud`
      // all give the same message, so the response is not an oracle.
      throw rpcUnauthorized('Invalid access token');
    }

    // Written under a symbol, so a client field of the same name has no effect —
    // see the comment on AUTH_CONTEXT.
    payload[AUTH_CONTEXT] = toAuthContext(claims);
    return true;
  }
}
