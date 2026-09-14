import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import {
  ExtractJwt,
  Strategy,
  type StrategyOptionsWithoutRequest,
} from 'passport-jwt';
import { AppConfigService } from '@app/config';
import {
  type AccessTokenPayload,
  type AuthContext,
  toAuthContext,
} from '@app/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: AppConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.jwtPublicKey,
      algorithms: ['RS256'],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      ignoreExpiration: false,
    } satisfies StrategyOptionsWithoutRequest);
  }

  validate(payload: AccessTokenPayload): AuthContext {
    return toAuthContext(payload);
  }
}
