import { SetMetadata } from '@nestjs/common';
import type { UserRoleName } from './auth-context.js';

export const ROLES_KEY = 'clauseiq:roles';

/**
 * Requires at least one of the listed roles: `@Roles('admin', 'analyst')` means
 * "admin OR analyst". Without the decorator a route is open to any
 * authenticated user.
 */
export const Roles = (...roles: UserRoleName[]) => SetMetadata(ROLES_KEY, roles);
