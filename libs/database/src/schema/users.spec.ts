import { USER_ROLES } from '@app/common';
import { userRole } from './users.js';

/**
 * `USER_ROLES` in `@app/common` and the `user_role` enum in the database are
 * deliberately two separate declarations — importing would break
 * `drizzle-kit generate`, which does not resolve `@app/*` aliases (see the note
 * on `USER_ROLES`).
 *
 * The price of that split is that they can drift, and drift would be silent and
 * expensive: a role present in a JWT claim but absent from the database would
 * pass `RolesGuard` and only fail at the `INSERT`. This test is the only thing
 * preventing it.
 */
describe('user_role enum', () => {
  it('matches USER_ROLES from @app/common', () => {
    expect([...userRole.enumValues]).toEqual([...USER_ROLES]);
  });
});
