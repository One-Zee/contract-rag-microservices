// Shared by the k6 scenarios. k6 runs its own JavaScript runtime:
// no Node APIs, no npm packages, no TypeScript here.
import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';

export const BASE = __ENV.BASE_URL || 'http://api-gateway:3000';

/** Closed model: VUS clients, each sending as soon as the last answer arrived (plus THINK_MS). */
export function options(name) {
  return {
    scenarios: {
      [name]: {
        executor: 'constant-vus',
        vus: Number(__ENV.VUS || 10),
        duration: __ENV.DURATION || '60s',
        gracefulStop: '60s',
      },
    },
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    setupTimeout: '120s',
  };
}

export function think() {
  const ms = Number(__ENV.THINK_MS || 0);
  if (ms > 0) sleep(ms / 1000);
}

/** One account for every client: the corpus a run searches is the same for all of them. */
export function login() {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: __ENV.LOAD_EMAIL, password: __ENV.LOAD_PASSWORD }),
    {
      headers: { 'content-type': 'application/json' },
      tags: { name: 'setup' },
    },
  );
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${res.body}`);
  }
  const body = res.json();
  return { token: body.accessToken, userId: body.user.id };
}

export const bearer = (data) => ({ authorization: `Bearer ${data.token}` });

/** The evaluation questions, as realistic query texts. */
export const questions = new SharedArray('questions', () =>
  JSON.parse(open('/dataset/questions.json'))
    .questions.filter((q) => q.kind === 'answerable')
    .map((q) => q.question),
);

export const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** The whole summary as JSON, for eval/load/summarize.ts. */
export function summary(data) {
  const out = __ENV.OUT
    ? `/results/${__ENV.OUT}/summary.json`
    : '/results/summary.json';
  const duration = data.metrics.http_req_duration.values;
  const line =
    `reqs ${data.metrics.http_reqs.values.count} (${data.metrics.http_reqs.values.rate.toFixed(1)}/s), ` +
    `failed ${(100 * (data.metrics.http_req_failed ? data.metrics.http_req_failed.values.rate : 0)).toFixed(2)} %, ` +
    `p50 ${duration.med.toFixed(1)} ms, p95 ${duration['p(95)'].toFixed(1)} ms, p99 ${duration['p(99)'].toFixed(1)} ms\n`;
  return { [out]: JSON.stringify(data, null, 1), stdout: line };
}
