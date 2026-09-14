import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule, AppConfigService } from '@app/config';

/**
 * A `JwtService` configured **for verification only** — public key, no private
 * key.
 *
 * Imported by the gateway and every protected service. `auth-service` does not
 * use this module: it also needs to sign, so it configures `JwtModule` itself
 * with the private key.
 *
 * `algorithms: ['RS256']` is not cosmetic. Without an explicit list
 * `jsonwebtoken` trusts the algorithm named in the token header, so an attacker
 * sends an HS256-signed token using the public key as the HMAC secret — the
 * public key is public, therefore known. The classic algorithm confusion attack.
 */
@Module({
  imports: [
    AppConfigModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        publicKey: config.jwtPublicKey,
        verifyOptions: {
          algorithms: ['RS256'],
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        },
      }),
    }),
  ],
  exports: [JwtModule],
})
export class JwtVerifierModule {}
