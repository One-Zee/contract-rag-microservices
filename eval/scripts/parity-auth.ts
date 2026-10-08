// Sends the same sequence of auth requests to the Nest gateway and to the
// Express twin and compares statuses and response shapes: the overhead
// comparison is only fair if both do the same thing.
//
//   npm run eval:parity [-- --nest http://localhost:3000 --express http://localhost:3100]
//
// Both targets must use the same database (DATABASE_URL, for promoting the
// probe account to admin) and THROTTLE_ENABLED=false on the gateway.
import { withDb } from '../lib/db.ts';
import { args, loadEnv } from '../lib/env.ts';

loadEnv();
const options = args();
const targets = {
  nest: String(options.get('nest') ?? 'http://localhost:3000'),
  express: String(options.get('express') ?? 'http://localhost:3100'),
};

interface Step {
  name: string;
  status: number;
  body: unknown;
}

async function call(
  base: string,
  method: string,
  path: string,
  init: { token?: string; body?: unknown; raw?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined || init.raw !== undefined)
    headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body:
      init.raw ??
      (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: response.status, body };
}

/** Values replaced by their type, so ids, tokens and dates compare as shapes. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

/**
 * Error bodies are compared by value — key order aside (the gateway itself
 * writes RPC-mapped errors and its own in different orders) and message
 * lists in any order.
 */
const isError = (status: number) => status >= 400;
function comparable(step: Step): unknown {
  if (!isError(step.status)) return shape(step.body);
  const body = step.body as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(body ?? {})
      .sort()
      .map((key) => [
        key,
        Array.isArray(body[key])
          ? [...(body[key] as string[])].sort()
          : body[key],
      ]),
  );
}

async function scenario(base: string, tag: string): Promise<Step[]> {
  const steps: Step[] = [];
  const record = (name: string, result: { status: number; body: unknown }) =>
    steps.push({ name, ...result });
  const email = `parity-${tag}-${Date.now()}@clauseiq.test`;
  const password = 'parity-check-password';

  record('health', await call(base, 'GET', '/health'));
  const registered = await call(base, 'POST', '/auth/register', {
    body: { email, password },
  });
  record('register', registered);
  record(
    'register again',
    await call(base, 'POST', '/auth/register', { body: { email, password } }),
  );
  record(
    'register invalid',
    await call(base, 'POST', '/auth/register', {
      body: { email: 'not-an-email', password: 'short', role: 'admin' },
    }),
  );
  record(
    'login wrong',
    await call(base, 'POST', '/auth/login', {
      body: { email, password: 'wrong-password-123' },
    }),
  );
  record(
    'login malformed',
    await call(base, 'POST', '/auth/login', { raw: '{"email":' }),
  );
  const login = await call(base, 'POST', '/auth/login', {
    body: { email, password },
  });
  record('login', login);
  const token = login.body.accessToken as string;
  const userId = login.body.user.id as string;

  record('me without token', await call(base, 'GET', '/auth/me'));
  record('me', await call(base, 'GET', '/auth/me', { token }));
  const first = login.body.refreshToken as string;
  const rotated = await call(base, 'POST', '/auth/refresh', {
    body: { refreshToken: first },
  });
  record('refresh', rotated);
  record(
    'refresh reused',
    await call(base, 'POST', '/auth/refresh', {
      body: { refreshToken: first },
    }),
  );
  record(
    'refresh after reuse',
    await call(base, 'POST', '/auth/refresh', {
      body: { refreshToken: rotated.body.refreshToken },
    }),
  );
  record('users as reader', await call(base, 'GET', '/users', { token }));
  record('user self', await call(base, 'GET', `/users/${userId}`, { token }));
  record(
    'user other',
    await call(base, 'GET', '/users/00000000-0000-4000-8000-000000000000', {
      token,
    }),
  );
  record(
    'user not uuid',
    await call(base, 'GET', '/users/not-a-uuid', { token }),
  );

  await withDb((db) =>
    db.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]),
  );
  const admin = await call(base, 'POST', '/auth/login', {
    body: { email, password },
  });
  const adminToken = admin.body.accessToken as string;
  record('users as admin', {
    status: (await call(base, 'GET', '/users', { token: adminToken })).status,
    body: null,
  });
  record(
    'user missing',
    await call(base, 'GET', '/users/00000000-0000-4000-8000-000000000000', {
      token: adminToken,
    }),
  );
  record('unknown route', await call(base, 'GET', '/nope'));
  return steps;
}

const nest = await scenario(targets.nest, 'nest');
const express = await scenario(targets.express, 'express');

let mismatches = 0;
for (const [i, left] of nest.entries()) {
  const right = express[i];
  // /health names its service; only the status and the keys must agree.
  const same =
    left.status === right.status &&
    (left.name === 'health'
      ? JSON.stringify(shape(left.body)) === JSON.stringify(shape(right.body))
      : JSON.stringify(comparable(left)) === JSON.stringify(comparable(right)));
  if (!same) mismatches++;
  console.log(
    `${same ? 'same' : 'DIFF'}  ${left.name.padEnd(20)} ${left.status} / ${right.status}`,
  );
  if (!same) {
    console.log(`      nest:    ${JSON.stringify(comparable(left))}`);
    console.log(`      express: ${JSON.stringify(comparable(right))}`);
  }
}
console.log(
  mismatches === 0
    ? 'Parity: all steps match'
    : `Parity: ${mismatches} differences`,
);
process.exitCode = mismatches === 0 ? 0 : 1;
