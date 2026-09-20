import type { AuthContext, UserRoleName } from '@app/common';
import { canManage, canRead } from './document-policy.js';

const as = (role: UserRoleName, userId = 'u-me'): AuthContext => ({
  userId,
  email: `${userId}@x.ba`,
  roles: [role],
});

const own = { uploadedBy: 'u-me' };
const foreign = { uploadedBy: 'u-other' };

describe('document policy', () => {
  describe('canRead', () => {
    it.each([
      ['reader', 'shared', foreign, true],
      ['reader', 'private', foreign, false],
      ['reader', 'private', own, false],
      ['analyst', 'shared', foreign, true],
      ['analyst', 'private', own, true],
      ['analyst', 'private', foreign, false],
      ['admin', 'private', foreign, true],
      ['admin', 'shared', foreign, true],
    ] as const)(
      '%s reading a %s document of %j → %s',
      (role, visibility, doc, expected) => {
        expect(canRead({ ...doc, visibility }, as(role))).toBe(expected);
      },
    );
  });

  describe('canManage', () => {
    it.each([
      ['reader', 'shared', foreign, false],
      ['reader', 'private', own, false],
      ['analyst', 'shared', foreign, false],
      ['analyst', 'private', own, true],
      ['analyst', 'shared', own, true],
      ['admin', 'private', foreign, true],
    ] as const)(
      '%s managing a %s document of %j → %s',
      (role, visibility, doc, expected) => {
        expect(canManage({ ...doc, visibility }, as(role))).toBe(expected);
      },
    );
  });
});
