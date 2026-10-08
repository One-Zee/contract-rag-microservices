// Derives the stub's latencies from the real evaluation runs, so that the
// load tests wait on the providers about as long as the system did with the
// real APIs:
//
//   - embedding and rerank: medians of the timings retrieval-service reported
//     in the retrieval run (hybrid+rerank, corpus-wide);
//   - the model: time to first token ≈ the client's TTFT minus the retrieval
//     the service did before calling the model; time per token from the
//     rest of the model call over the tokens it produced.
//
//   node eval/load/calibrate-stub.ts [--experiment contracts_eval --label run]
//
// Writes eval/results/load/stub.env, which run-load.ts passes to the stub.
import { join } from 'node:path';
import { args, loadEnv } from '../lib/env.ts';
import { readJson, writeJson, writeText } from '../lib/json.ts';
import { latestRaw } from '../lib/latest.ts';
import { EVAL_ROOT } from '../lib/paths.ts';
import { percentile } from '../lib/stats.ts';

loadEnv();
const options = args();
const experiment = String(options.get('experiment') ?? 'contracts_eval');
const label = String(options.get('label') ?? 'run');
const median = (values: number[]) => percentile(values, 50);

const retrieval = readJson<{
  records: {
    config: string;
    scope: string;
    reranker: string;
    timings: { embeddingMs: number; rerankMs: number };
  }[];
}>(latestRaw(experiment, 'retrieval'));
const reranked = retrieval.records.filter(
  (r) =>
    r.config === 'hybrid+rerank' &&
    r.scope === 'corpus' &&
    r.reranker !== 'none',
);
const embedded = retrieval.records.filter(
  (r) => r.scope === 'corpus' && r.timings.embeddingMs > 0,
);

const answers = readJson<{
  answers: {
    status: string;
    clientTtftMs: number | null;
    usage: { tokensOut: number } | null;
    timings: { retrievalMs: number; llmMs: number } | null;
  }[];
}>(latestRaw(experiment, `answers-${label}`)).answers.filter(
  (a) =>
    a.status === 'answered' &&
    a.clientTtftMs !== null &&
    a.timings &&
    a.usage &&
    a.usage.tokensOut > 0,
);
const ttft = answers.map((a) =>
  Math.max(0, (a.clientTtftMs as number) - (a.timings?.retrievalMs ?? 0)),
);
const perToken = answers.map(
  (a, i) =>
    Math.max(0, (a.timings?.llmMs ?? 0) - ttft[i]) / (a.usage?.tokensOut ?? 1),
);

const values = {
  STUB_EMBED_MS: Math.round(median(embedded.map((r) => r.timings.embeddingMs))),
  STUB_RERANK_MS: reranked.length
    ? Math.round(median(reranked.map((r) => r.timings.rerankMs)))
    : 200,
  STUB_LLM_TTFT_MS: Math.round(median(ttft)),
  STUB_LLM_TOKEN_MS: Math.round(median(perToken) * 10) / 10,
  STUB_LLM_TOKENS: Math.round(
    median(answers.map((a) => a.usage?.tokensOut ?? 0)),
  ),
};
const basis = {
  experiment,
  retrievalRecords: embedded.length,
  rerankedRecords: reranked.length,
  answers: answers.length,
};

writeJson(join(EVAL_ROOT, 'results', experiment, 'stub-calibration.json'), {
  values,
  basis,
});
writeText(
  join(EVAL_ROOT, 'results', 'load', 'stub.env'),
  `# From ${experiment} (${JSON.stringify(basis)}) — eval/load/calibrate-stub.ts\n${Object.entries(
    values,
  )
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`,
);
console.log(values, basis);
