// Asks every question through POST /query (SSE) and records what the system
// answered, cited and spent — the input of the judge and of §9.3/§9.6.
//
//   npm run eval:answers [-- --allow-draft --label t0 --mode hybrid --rerank true]
//
// The services decide the model, the threshold and the prices from their own
// environment; start them from the shell this runs in (eval/README.md).
import { join } from 'node:path';
import { Gateway } from '../lib/api.ts';
import { loadQuestions } from '../lib/dataset.ts';
import { withDb } from '../lib/db.ts';
import { args, experimentName, gatewayUrl, loadEnv } from '../lib/env.ts';
import { writeJson } from '../lib/json.ts';
import { resultsDir } from '../lib/paths.ts';
import { rerankConfigured, rerankPacer } from '../lib/rerank.ts';
import { runInfo } from '../lib/run-info.ts';

loadEnv();
const options = args();
const experiment = experimentName();
const label = String(options.get('label') ?? 'run');
const mode = String(options.get('mode') ?? 'hybrid');
const rerankOption = options.get('rerank');
const rerank = rerankOption === undefined ? undefined : rerankOption === 'true';
// The answer does not say whether its context was reranked, so a run that
// reranks is paced under the provider's limit instead of checked afterwards
// (a failed rerank also leaves a warning in the retrieval-service log).
const pace = rerankPacer();
const reranks = rerank ?? rerankConfigured();

const questions = loadQuestions(options.has('allow-draft')).questions;
const gateway = new Gateway(gatewayUrl());
await gateway.login(
  process.env.EVAL_EMAIL ?? 'evaluation@clauseiq.test',
  process.env.EVAL_PASSWORD ?? 'evaluation-only-password',
);

const answers = [];
for (const question of questions) {
  if (reranks) {
    await pace();
  }
  const result = await gateway.ask({
    question: question.question,
    mode,
    rerank,
  });
  answers.push({
    question: question.id,
    kind: question.kind,
    answer: result.done?.answer ?? null,
    status: result.done?.status ?? 'error',
    abstained: result.done?.abstained ?? null,
    abstainReason: result.done?.abstainReason ?? null,
    citations: result.done?.citations ?? [],
    invalidCitations: result.done?.invalidCitations ?? [],
    sources: result.sources,
    usage: result.done?.usage ?? null,
    timings: result.done?.timings ?? null,
    clientTtftMs: result.ttftMs,
    clientTotalMs: result.totalMs,
    model: result.done?.model ?? null,
    error: result.error,
  });
  process.stdout.write(result.done?.abstained ? 'a' : result.done ? '.' : 'x');
}
process.stdout.write('\n');

// The chunk texts the judge needs: what each citation pointed at.
const chunkIds = [
  ...new Set(answers.flatMap((a) => a.citations.map((c) => c.chunkId))),
];
const texts = await withDb(async (db) => {
  const { rows } = await db.query<{ id: string; content: string }>(
    'SELECT id, content FROM chunks WHERE id = ANY($1::uuid[])',
    [chunkIds],
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.content]));
});

const info = runInfo(experiment);
const stamp = info.startedAt.replace(/[:.]/g, '-');
const file = join(
  resultsDir(experiment, 'raw'),
  `answers-${label}-${stamp}.json`,
);
writeJson(file, {
  info,
  label,
  mode,
  rerank: rerank ?? null,
  answers,
  chunks: texts,
});

const abstained = answers.filter((a) => a.abstained).length;
const failed = answers.filter(
  (a) => a.status === 'error' || a.status === 'failed',
).length;
console.log(
  `${answers.length} questions: ${abstained} abstained, ${failed} failed → ${file}`,
);
