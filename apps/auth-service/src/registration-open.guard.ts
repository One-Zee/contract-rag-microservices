import { type CanActivate, Injectable } from '@nestjs/common';
import { rpcForbidden } from '@app/common';
import { AppConfigService } from '@app/config';

/**
 * Closes `auth.register` when `AUTH_REGISTRATION_ENABLED=false`.
 *
 * A guard rather than a check in `AuthService.register`: whether the door is
 * open is a property of the route, not of what registering does. It throws
 * the contract's 403 instead of returning `false`, which Nest would turn into
 * a bare "Forbidden resource" the gateway cannot map.
 *
 * Read on every call, so the switch works without a rebuild — but a restart
 * is still needed for a new value, since the environment is read at boot.
 */
@Injectable()
export class RegistrationOpenGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(): boolean {
    if (!this.config.registrationEnabled) {
      throw rpcForbidden('Registration is closed');
    }
    return true;
  }
}
