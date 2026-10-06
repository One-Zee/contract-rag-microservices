// Picks QUERY_MIN_SIMILARITY from the data instead of guessing it.
// llm-service abstains before calling the model when the best cosine
// similarity among the chunks it would put in the prompt is below the
// threshold; this replays that rule over the last retrieval run, separating
// answerable from out-of-corpus questions, and maximises Youden's J
// (correct abstentions − wrong abstentions).
//
//   npm run eval:threshold [-- --config hybrid+rerank --context 5 --run <file>]
import { join } from 'node:path';
import { args, experimentName, loadEnv } from '../lib/env.ts';
import { readJson, writeJson, writeText } from '../lib/json.ts';
import { latestRaw } from '../lib/latest.ts';
import { resultsDir } from '../lib/paths.ts';

loadEnv();
const options = args();
const experiment = experimentName();
const runFile = String(
  options.get('run') ?? latestRaw(experiment, 'retrieval'),
);
const CONTEXT = Number(
  options.get('context') ?? process.env.QUERY_CONTEXT_CHUNKS ?? 5,
);

interface Record_ {
  question: string;
  kind: string;
  config: string;
  scope: string;
  reranker: string;
  similarities: number[];
  scores: unknown;
}
const { records } = readJson<{ records: Record_[] }>(runFile);
const available = new Set(
  records.filter((r) => r.reranker !== 'none').map((r) => r.config),
);
const config = String(
  options.get('config') ??
    (available.has('hybrid+rerank') ? 'hybrid+rerank' : 'hybrid'),
);

const best = (record: Record_): number =>
  Math.max(0, ...record.similarities.slice(0, CONTEXT));
const rows = records.filter((r) => r.scope === 'corpus' && r.config === config);
const answerable = rows
  .filter((r) => r.kind === 'answerable' && r.scores)
  .map(best);
// The threshold before the model only answers "is there anything relevant in
// the corpus at all?". A clause missing from a contract that IS in the corpus
// is the other abstention path's case (the model finds nothing to cite) —
// its excerpts come from the right contract and score like an answer's, so
// optimising for it costs abstentions on answerable questions.
// The threshold is therefore calibrated on out-of-corpus questions; the
// absent ones are reported, and so is what all unanswerable together pick.
const outOfCorpus = rows.filter((r) => r.kind === 'out_of_corpus').map(best);
const absent = rows.filter((r) => r.kind === 'absent').map(best);
if (answerable.length === 0 || outOfCorpus.length === 0) {
  throw new Error('Need answerable and out-of-corpus questions in the run');
}

const share = (values: number[], threshold: number): number =>
  values.filter((value) => value < threshold).length / values.length;

interface Point {
  threshold: number;
  correct: number;
  wrong: number;
  j: number;
}
function calibrate(unanswerable: number[]): { chosen: Point; curve: Point[] } {
  const curve: Point[] = [];
  for (let step = 0; step <= 200; step++) {
    const threshold = step / 200;
    const correct = share(unanswerable, threshold);
    const wrong = share(answerable, threshold);
    curve.push({ threshold, correct, wrong, j: correct - wrong });
  }
  // Every threshold in the gap between the groups has the same J; the middle
  // of that run is the one least sensitive to the next question's score.
  const top = Math.max(...curve.map((point) => point.j));
  const best = curve.filter((point) => point.j === top);
  return { chosen: best[Math.floor((best.length - 1) / 2)], curve };
}
const { chosen, curve } = calibrate(outOfCorpus);
const allUnanswerable = calibrate([...outOfCorpus, ...absent]).chosen;

const pct = (value: number): string => `${(100 * value).toFixed(0)} %`;
const range = (values: number[]): string =>
  values.length === 0
    ? '—'
    : `${Math.min(...values).toFixed(3)}–${Math.max(...values).toFixed(3)}`;

const dir = resultsDir(experiment);
writeJson(join(dir, 'threshold.json'), {
  run: runFile,
  config,
  context: CONTEXT,
  answerable: answerable.length,
  outOfCorpus: outOfCorpus.length,
  absent: absent.length,
  chosen,
  absentAbstained: share(absent, chosen.threshold),
  allUnanswerable,
  curve,
});
const text = [
  `# Abstention threshold — ${experiment}`,
  '',
  `Config ${config}, best similarity among the top ${CONTEXT} chunks, corpus-wide. Ranges: answerable ${range(answerable)} (${answerable.length}), out of corpus ${range(outOfCorpus)} (${outOfCorpus.length}), absent clause ${range(absent)} (${absent.length}).`,
  '',
  `**QUERY_MIN_SIMILARITY = ${chosen.threshold.toFixed(3)}** — abstains before the model on ${pct(chosen.correct)} of the out-of-corpus questions and wrongly on ${pct(chosen.wrong)} of the answerable ones (J = ${chosen.j.toFixed(2)}); it stops ${pct(share(absent, chosen.threshold))} of the absent-clause questions, which are left to the model.`,
  '',
  `Calibrated on every unanswerable question instead, it would be ${allUnanswerable.threshold.toFixed(3)}: ${pct(allUnanswerable.correct)} of them stopped, ${pct(allUnanswerable.wrong)} of the answerable ones wrongly (J = ${allUnanswerable.j.toFixed(2)}).`,
  '',
  'With this few unanswerable questions every percentage step is one question; treat the value as a calibration of this corpus, not a constant.',
].join('\n');
writeText(join(dir, 'threshold.md'), `${text}\n`);
console.log(text);
