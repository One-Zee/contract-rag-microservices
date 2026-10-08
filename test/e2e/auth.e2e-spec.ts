/**
 * The full chain over a real TCP transport and a real Postgres:
 * HTTP → api-gateway → TCP → auth-service → Drizzle.
 *
 * Lives outside `apps/` on purpose: it imports two services, which
 * `no-cross-app-imports` forbids inside any one of them. A system test sits
 * above the services rather than inside one.
 *
 * Needs `DATABASE_URL` (from `.env` locally, from the job env in CI) with the
 * migrations applied. Everything else — the RS256 key pair, the ports — is
 * generated here so the test does not depend on anyone's `.env`.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication, INestMicroservice } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import request from 'supertest';
import type { AuthTokensDto } from '@app/common';
import {
  DRIZZLE,
  type DrizzleDatabase,
  refreshTokens,
  users,
} from '@app/database';
import {
  bearer,
  configureAuthEnv,
  PASSWORD,
  rsaPair,
  signWith,
} from './helpers.js';

// `AppConfigModule.forRoot()` validates the environment when it is called,
// which is when a module file is imported — so the environment has to be in
// place before the dynamic imports in `beforeAll`, and static imports of the
// app modules would be too early.
const { keys, authPort: AUTH_PORT } = configureAuthEnv();

describe('auth (e2e)', () => {
  let gateway: INestApplication;
  let auth: INestMicroservice;
  let db: DrizzleDatabase;
  const createdUserIds: string[] = [];

  const http = () => request(gateway.getHttpServer());

  const email = `e2e-${randomUUID()}@example.test`;
  const otherEmail = `e2e-${randomUUID()}@example.test`;
  let me: AuthTokensDto;
  let other: AuthTokensDto;

  beforeAll(async () => {
    const [
      { AuthServiceModule },
      { ApiGatewayModule },
      { createValidationPipe },
    ] = await Promise.all([
      import('../../apps/auth-service/src/auth-service.module.js'),
      import('../../apps/api-gateway/src/api-gateway.module.js'),
      import('../../apps/api-gateway/src/validation.js'),
    ]);

    const authModule = await Test.createTestingModule({
      imports: [AuthServiceModule],
    }).compile();
    auth = authModule.createNestMicroservice({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: AUTH_PORT },
      logger: false,
    });
    await auth.listen();
    db = authModule.get<DrizzleDatabase>(DRIZZLE);

    const gatewayModule = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    }).compile();
    gateway = gatewayModule.createNestApplication({ logger: false });
    gateway.useGlobalPipes(createValidationPipe());
    await gateway.init();
  });

  afterAll(async () => {
    if (db && createdUserIds.length > 0) {
      // cascades to refresh_tokens
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await gateway?.close();
    await auth?.close();
  });

  describe('registration', () => {
    it('registers and issues a token pair with the default role', async () => {
      const res = await http()
        .post('/auth/register')
        .send({ email, password: PASSWORD, fullName: 'E2E' })
        .expect(201);

      me = res.body;
      createdUserIds.push(me.user.id);
      expect(me.user).toMatchObject({ email, role: 'reader' });
      expect(me.user).not.toHaveProperty('passwordHash');
      expect(me.accessToken.split('.')).toHaveLength(3);
      expect(me.refreshToken.split('.')).toHaveLength(1);
    });

    it('rejects the same e-mail again with 409', async () => {
      await http()
        .post('/auth/register')
        .send({ email, password: PASSWORD })
        .expect(409);
    });

    it('rejects a body that tries to pick its own role', async () => {
      await http()
        .post('/auth/register')
        .send({ email: otherEmail, password: PASSWORD, role: 'admin' })
        .expect(400);
    });

    it('registers a second user', async () => {
      const res = await http()
        .post('/auth/register')
        .send({ email: otherEmail, password: PASSWORD })
        .expect(201);

      other = res.body;
      createdUserIds.push(other.user.id);
    });
  });

  describe('login', () => {
    it('rejects a wrong password with 401', async () => {
      await http()
        .post('/auth/login')
        .send({ email, password: 'definitely-not-it-1' })
        .expect(401);
    });

    it('rejects an unknown e-mail with the same 401', async () => {
      const wrongPassword = await http()
        .post('/auth/login')
        .send({ email, password: 'definitely-not-it-1' });
      const unknownUser = await http()
        .post('/auth/login')
        .send({
          email: `nobody-${randomUUID()}@example.test`,
          password: PASSWORD,
        });

      expect(unknownUser.status).toBe(401);
      expect(unknownUser.body.message).toBe(wrongPassword.body.message);
    });

    it('logs in', async () => {
      const res = await http()
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      me = res.body;
      expect(me.user.id).toBe(createdUserIds[0]);
    });
  });

  describe('token verification at the gateway', () => {
    it('GET /auth/me returns the claims without a TCP call', async () => {
      const res = await http()
        .get('/auth/me')
        .set(bearer(me.accessToken))
        .expect(200);

      expect(res.body).toEqual({
        userId: me.user.id,
        email,
        roles: ['reader'],
      });
    });

    it('rejects a missing token', async () => {
      await http().get('/auth/me').expect(401);
    });

    it('rejects a token signed with a foreign key', async () => {
      const forged = signWith(rsaPair().privateKey).sign({
        sub: me.user.id,
        email,
        roles: ['admin'],
      });

      await http().get('/auth/me').set(bearer(forged)).expect(401);
    });

    it('rejects a token with the wrong audience', async () => {
      const token = signWith(keys.privateKey, {
        audience: 'someone-else',
      }).sign({ sub: me.user.id, email, roles: ['reader'] });

      await http().get('/auth/me').set(bearer(token)).expect(401);
    });

    it('rejects an expired token', async () => {
      const token = signWith(keys.privateKey, { expiresIn: '-1s' }).sign({
        sub: me.user.id,
        email,
        roles: ['reader'],
      });

      await http().get('/auth/me').set(bearer(token)).expect(401);
    });

    it('rejects a token whose claims were edited after signing', async () => {
      const [header, payload, signature] = me.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const tampered = Buffer.from(
        JSON.stringify({ ...claims, roles: ['admin'] }),
      ).toString('base64url');

      await http()
        .get('/users')
        .set(bearer(`${header}.${tampered}.${signature}`))
        .expect(401);
    });
  });

  describe('authorization', () => {
    it('forbids a reader from listing users', async () => {
      await http().get('/users').set(bearer(me.accessToken)).expect(403);
    });

    it('lets a user read their own account over TCP', async () => {
      const res = await http()
        .get(`/users/${me.user.id}`)
        .set(bearer(me.accessToken))
        .expect(200);

      expect(res.body).toMatchObject({ id: me.user.id, email });
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it("forbids a reader from reading someone else's account", async () => {
      await http()
        .get(`/users/${other.user.id}`)
        .set(bearer(me.accessToken))
        .expect(403);
    });

    it('rejects a malformed id before the TCP hop', async () => {
      await http()
        .get('/users/not-a-uuid')
        .set(bearer(me.accessToken))
        .expect(400);
    });
  });

  describe('refresh token rotation', () => {
    let rotated: AuthTokensDto;

    it('rotates: a new pair, and a different refresh token', async () => {
      const res = await http()
        .post('/auth/refresh')
        .send({ refreshToken: me.refreshToken })
        .expect(200);

      rotated = res.body;
      expect(rotated.refreshToken).not.toBe(me.refreshToken);
      expect(rotated.user.id).toBe(me.user.id);
    });

    it('rejects the spent token', async () => {
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: me.refreshToken })
        .expect(401);
    });

    it('has revoked the whole family — the fresh token is dead too', async () => {
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: rotated.refreshToken })
        .expect(401);

      const [{ active }] = await db
        .select({ active: count() })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, me.user.id),
            isNull(refreshTokens.revokedAt),
          ),
        );
      expect(active).toBe(0);
    });

    it('rejects a token that was never issued', async () => {
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: 'a'.repeat(43) })
        .expect(401);
    });

    it('lets the user log in again after the family was revoked', async () => {
      const res = await http()
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      me = res.body;
    });

    /**
     * The race the compare-and-swap in `RefreshTokensRepository.rotate` closes.
     * Two requests with the same token at the same time: both may read the
     * row as unspent, but only one UPDATE ... WHERE revoked_at IS NULL can
     * match. Without the condition both would succeed and reuse detection
     * would never fire.
     */
    it('lets exactly one of two concurrent refreshes through', async () => {
      // Every earlier request was sequential, so the pool holds one client.
      // Cold, the second request would spend ~15 ms opening a connection and
      // read the row only after the first had committed — the sequential path,
      // not the race. Warm it so both reads run side by side.
      await Promise.all(
        Array.from({ length: 4 }, () => db.execute(sql`select 1`)),
      );

      const [a, b] = await Promise.all([
        http().post('/auth/refresh').send({ refreshToken: me.refreshToken }),
        http().post('/auth/refresh').send({ refreshToken: me.refreshToken }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 401]);

      // the loser was treated as reuse, so the winner's new token is gone too
      const [{ active }] = await db
        .select({ active: count() })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.userId, me.user.id),
            isNull(refreshTokens.revokedAt),
          ),
        );
      expect(active).toBe(0);
    });
  });

  describe('admin', () => {
    /**
     * The role cannot be obtained through the API — that is the point — so it
     * is set in the database, followed by a fresh login for a token that
     * carries it.
     */
    it('becomes admin only through the database', async () => {
      await db
        .update(users)
        .set({ role: 'admin' })
        .where(eq(users.id, me.user.id));

      const res = await http()
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      me = res.body;
      expect(me.user.role).toBe('admin');
    });

    it('lists users', async () => {
      const res = await http()
        .get('/users')
        .set(bearer(me.accessToken))
        .expect(200);

      const ids = (res.body as Array<{ id: string }>).map((u) => u.id);
      expect(ids).toEqual(expect.arrayContaining(createdUserIds));
    });

    it("reads someone else's account", async () => {
      const res = await http()
        .get(`/users/${other.user.id}`)
        .set(bearer(me.accessToken))
        .expect(200);

      expect(res.body.id).toBe(other.user.id);
    });
  });
});
