import { USER_ROLES } from '@app/common';
import { userRole } from './users.js';

/**
 * `USER_ROLES` in `@app/common` and the `user_role` enum in the database are
 * deliberately two separate declarations — importing would break
 * `drizzle-kit generate`, which does not resolve `@app/*` aliases (see the note
 * on `USER_ROLES`).
 *
 */
describe('user_role enum', () => {
  it('matches USER_ROLES from @app/common', () => {
    expect([...userRole.enumValues]).toEqual([...USER_ROLES]);
  });
});
