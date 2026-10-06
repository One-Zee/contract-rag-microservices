import bcrypt from 'bcrypt';
import { Router } from 'express';
import Joi from 'joi';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, requireAuth, requireRole, validateBody } from './http.js';
import { hashToken, mintRefreshToken, signAccessToken } from './tokens.js';

const BCRYPT_ROUNDS = 12;
const INVALID_CREDENTIALS = 'Invalid e-mail or password';
// Same purpose as in auth-service: a missing user costs the same bcrypt work.
const DUMMY_HASH =
  '$2b$12$C6UzMDM.H6dfI/f/IKcEe.mTC0BUR3vHhwWQ7hnrOCVOgWCwFTLGm';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const registerBody = Joi.object({
  email: Joi.string().email({ tlds: false }).required().messages({
    '*': 'email must be a valid e-mail address',
  }),
  password: Joi.string().min(12).max(72).required().messages({
    'string.base': 'password must be a string',
    'string.min': 'password must be at least 12 characters',
    'string.max': 'password must not exceed 72 bytes (bcrypt limit)',
    'any.required': 'password must be a string',
  }),
  fullName: Joi.string().max(200).messages({
    'string.base': 'fullName must be a string',
    'string.max': 'fullName must be shorter than or equal to 200 characters',
  }),
});
const loginBody = Joi.object({
  email: Joi.string()
    .email({ tlds: false })
    .required()
    .messages({ '*': 'email must be an email' }),
  password: Joi.string()
    .required()
    .messages({ '*': 'password should not be empty' }),
});
const refreshBody = Joi.object({
  refreshToken: Joi.string()
    .required()
    .messages({ '*': 'refreshToken should not be empty' }),
});

const toUserDto = (user: db.User) => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  role: user.role,
  createdAt: user.createdAt,
});

async function issueTokens(user: db.User) {
  const { token, ...row } = mintRefreshToken();
  await db.createRefreshToken({ userId: user.id, ...row });
  return {
    accessToken: signAccessToken(user),
    refreshToken: token,
    user: toUserDto(user),
  };
}

async function onReuse(userId: string): Promise<never> {
  const revoked = await db.revokeAllRefreshTokens(userId);
  console.warn(
    `Refresh token reuse detected for user ${userId} — revoked ${revoked} active tokens`,
  );
  throw new HttpError(401, 'Refresh token has already been used');
}

export const routes = Router();

routes.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'express-auth' });
});

routes.post('/auth/register', validateBody(registerBody), async (req, res) => {
  if (!config.registrationEnabled) {
    throw new HttpError(403, 'Registration is closed');
  }
  const email = req.body.email.trim().toLowerCase();
  if (await db.findUserByEmail(email)) {
    throw new HttpError(409, 'A user with this e-mail address already exists');
  }
  const user = await db.createUser({
    email,
    passwordHash: await bcrypt.hash(req.body.password, BCRYPT_ROUNDS),
    fullName: req.body.fullName ?? null,
  });
  res.status(201).json(await issueTokens(user));
});

routes.post('/auth/login', validateBody(loginBody), async (req, res) => {
  const user = await db.findUserByEmail(req.body.email.trim().toLowerCase());
  const matches = await bcrypt.compare(
    req.body.password,
    user?.passwordHash ?? DUMMY_HASH,
  );
  if (!user || !matches) {
    throw new HttpError(401, INVALID_CREDENTIALS);
  }
  res.json(await issueTokens(user));
});

routes.post('/auth/refresh', validateBody(refreshBody), async (req, res) => {
  const record = await db.findRefreshToken(hashToken(req.body.refreshToken));
  if (!record) {
    throw new HttpError(401, 'Invalid refresh token');
  }
  if (record.revokedAt) {
    await onReuse(record.userId);
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(401, 'Refresh token has expired');
  }
  const user = await db.findUserById(record.userId);
  if (!user) {
    throw new HttpError(401, 'Invalid refresh token');
  }
  const { token, ...row } = mintRefreshToken();
  if (!(await db.rotateRefreshToken(record.id, { userId: user.id, ...row }))) {
    await onReuse(record.userId);
  }
  res.json({
    accessToken: signAccessToken(user),
    refreshToken: token,
    user: toUserDto(user),
  });
});

routes.get('/auth/me', requireAuth, (req, res) => {
  res.json(req.auth);
});

routes.get('/users', requireAuth, requireRole('admin'), async (_req, res) => {
  res.json((await db.listUsers()).map(toUserDto));
});

routes.get('/users/:id', requireAuth, async (req, res) => {
  const id = req.params.id as string;
  if (!UUID.test(id)) {
    throw new HttpError(400, 'Validation failed (uuid is expected)');
  }
  const auth = req.auth;
  if (auth?.userId !== id && !auth?.roles.includes('admin')) {
    throw new HttpError(403, 'You may only access your own account');
  }
  const user = await db.findUserById(id);
  if (!user) {
    throw new HttpError(404, 'User does not exist');
  }
  res.json(toUserDto(user));
});
