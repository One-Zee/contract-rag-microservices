// POST /query (SSE) under N concurrent clients: the whole question —
// retrieval, the prompt, the (stubbed) model streaming its answer, the log.
// k6 reads the stream to its end, so the duration is the full answer; the
// time to first token comes from the service's own histogram (Prometheus).
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
  ...base('query'),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Always true: only here so the summary carries this sub-metric, which
    // leaves out the setup login (eval/load/summarize.ts).
    'http_req_duration{name:query}': ['max>=0'],
  },
};

export const setup = login;

export default function (data) {
  const res = http.post(
    `${BASE}/query`,
    JSON.stringify({ question: pick(questions) }),
    {
      headers: {
        ...bearer(data),
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      timeout: '120s',
      tags: { name: 'query' },
    },
  );
  check(res, {
    'status 200': (r) => r.status === 200,
    'answer finished': (r) =>
      typeof r.body === 'string' && r.body.includes('event: done'),
  });
  think();
}

export const handleSummary = summary;
