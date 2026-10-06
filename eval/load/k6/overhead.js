// One auth endpoint at saturation, for the framework-overhead comparison:
// the same request against the Express twin, the Nest monolith and the Nest
// services. ENDPOINT is one of
//   health — no work at all: the framework's own cost per request
//   me     — verify a JWT and echo the claims
//   user   — verify a JWT, then read one row (over a hop in the services)
//   login  — bcrypt dominates: what the overhead looks like next to real work
import http from 'k6/http';
import { check } from 'k6';
import { BASE, bearer, login, options as base, summary } from './lib.js';

const ENDPOINT = __ENV.ENDPOINT || 'health';

export const options = {
  ...base(`overhead-${ENDPOINT}`),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Always true: only here so the summary carries this sub-metric.
    [`http_req_duration{name:${ENDPOINT}}`]: ['max>=0'],
  },
};

export const setup = login;

const credentials = JSON.stringify({
  email: __ENV.LOAD_EMAIL,
  password: __ENV.LOAD_PASSWORD,
});

export default function (data) {
  let res;
  if (ENDPOINT === 'health') {
    res = http.get(`${BASE}/health`, { tags: { name: 'health' } });
  } else if (ENDPOINT === 'me') {
    res = http.get(`${BASE}/auth/me`, {
      headers: bearer(data),
      tags: { name: 'me' },
    });
  } else if (ENDPOINT === 'user') {
    res = http.get(`${BASE}/users/${data.userId}`, {
      headers: bearer(data),
      tags: { name: 'user' },
    });
  } else {
    res = http.post(`${BASE}/auth/login`, credentials, {
      headers: { 'content-type': 'application/json' },
      tags: { name: 'login' },
    });
  }
  check(res, { 'status 200': (r) => r.status === 200 });
}

export const handleSummary = summary;
