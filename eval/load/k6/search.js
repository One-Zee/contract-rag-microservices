// GET /search under N concurrent clients: retrieval alone, the part of a
// question that the system itself does (the stub stands in for embedding).
import http from 'k6/http';
import { check } from 'k6';
import {
  BASE,
  bearer,
  login,
  options as base,
  pick,
  questions,
  summary,
  think,
} from './lib.js';

export const options = {
  ...base('search'),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Always true: only here so the summary carries this sub-metric, which
    // leaves out the setup login (eval/load/summarize.ts).
    'http_req_duration{name:search}': ['max>=0'],
  },
};

export const setup = login;

export default function (data) {
  const q = encodeURIComponent(pick(questions));
  const res = http.get(`${BASE}/search?q=${q}&mode=hybrid&limit=5`, {
    headers: bearer(data),
    tags: { name: 'search' },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
  think();
}

export const handleSummary = summary;
