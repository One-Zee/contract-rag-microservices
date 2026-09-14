import { Module } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import {
  AppConfigModule,
  AppConfigService,
  authSchema,
  authSigningSchema,
  baseSchema,
  databaseSchema,
} from '@app/config';
import { DrizzleModule } from '@app/database';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { UsersRepository } from './repositories/users.repository.js';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository.js';

@Module({
  imports: [
    /**
     * The only service that composes `authSigningSchema`, and therefore the only
     * one that validates `JWT_PRIVATE_KEY` at all. That makes "the private key
     * exists only here" checkable in the configuration rather than merely stated
     * in the docs (ADR 003, 004).
     */
    AppConfigModule.forRoot(
      baseSchema
        .concat(authSchema)
        .concat(authSigningSchema)
        .concat(databaseSchema),
    ),
    DrizzleModule,
    /**
     * Both keys: the private one signs access tokens, the public one verifies
     * them when `RpcAuthGuard` checks an incoming call. `JwtVerifierModule` from
     * `@app/common` is not used here because it only brings verification.
     */
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): JwtModuleOptions => ({
        privateKey: config.jwtPrivateKey,
        publicKey: config.jwtPublicKey,
        signOptions: {
          algorithm: 'RS256',
          // `jsonwebtoken` wants a literal like `15m`, the getter returns
          // `string`. The Joi schema guarantees the shape (`/^\d+[smhd]$/`), so
          // the narrowing is safe — a malformed value would not survive
          // validation at boot.
          expiresIn: config.jwtExpiresIn as NonNullable<
            JwtModuleOptions['signOptions']
          >['expiresIn'],
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        },
        // Without an explicit algorithm list `jsonwebtoken` trusts the `alg`
        // field of the token itself — the road to an algorithm confusion attack.
        verifyOptions: {
          algorithms: ['RS256'],
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    UsersRepository,
    RefreshTokensRepository,
  ],
})
export class AuthServiceModule {}
