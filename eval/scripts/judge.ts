// Grades one answers run with an LLM judge (§9.3) and exports a sample of
// its verdicts for the author to grade by hand (agreement.ts).
//
//   npm run eval:judge [-- --label t0 --run <file> --sample 0.2]
//
// Needs ANTHROPIC_API_KEY. The judge is a stronger model than the one judged
// (JUDGE_MODEL, default claude-sonnet-5). Its verdicts are kept, so a result
// is reproduced from the file, not by asking the judge again.
import { basename, join } from 'node:path';
import { toCsv } from '../lib/csv.ts';
import { loadQuestions, type Question } from '../lib/dataset.ts';
import { args, experimentName, loadEnv, requireEnv } from '../lib/env.ts';
import { readJson, writeJson, writeText } from '../lib/json.ts';
import {
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM,
  type Judgement,
  judgeUserMessage,
  parseJudgement,
} from '../lib/judge-prompt.ts';
import { latestRaw } from '../lib/latest.ts';
import { resultsDir } from '../lib/paths.ts';
import { seededRandom, shuffled } from '../lib/random.ts';

loadEnv();
const options = args();
const experiment = experimentName();
const label = String(options.get('label') ?? 'run');
const runFile = String(
  options.get('run') ?? latestRaw(experiment, `answers-${label}`),
);
const SAMPLE = Number(options.get('sample') ?? 0.2);
const MODEL = process.env.JUDGE_MODEL ?? 'claude-sonnet-5';
// Only ever overridden to dry-run the harness against the load-test stub.
const BASE_URL = process.env.JUDGE_BASE_URL ?? 'https://api.anthropic.com';
const apiKey = requireEnv('ANTHROPIC_API_KEY');
// Sent only when set, as with LLM_TEMPERATURE: claude-sonnet-5 rejects
// `temperature` outright (HTTP 400, "deprecated for this model").
const TEMPERATURE =
  process.env.JUDGE_TEMPERATURE === undefined
    ? undefined
    : Number(process.env.JUDGE_TEMPERATURE);

interface AnswerRecord {
  question: string;
  kind: string;
  answer: string | null;
  status: string;
  abstained: boolean | null;
  citations: { marker: number; chunkId: string }[];
}
const run = readJson<{
  answers: AnswerRecord[];
  chunks: Record<string, string>;
}>(runFile);
const questions = new Map(
  loadQuestions(true).questions.map((question) => [question.id, question]),
);

function reference(question: Question): string {
  if (question.kind === 'absent') {
    return 'The contract contains no such clause. A correct answer says the information is not in the contract.';
  }
  if (question.kind === 'out_of_corpus') {
    return 'This contract is not among the documents available. A correct answer says the information is not available.';
  }
  const spans = question.gold
    .map((span) => `"${span.text.replace(/\s+/g, ' ').trim()}"`)
    .join('\n');
  return question.normalized && !/^(yes|no)$/i.test(question.normalized)
    ? `${spans}\n(normalised answer: ${question.normalized})`
    : spans;
}

async function judge(
  input: Parameters<typeof judgeUserMessage>[0],
): Promise<Judgement> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        ...(TEMPERATURE === undefined ? {} : { temperature: TEMPERATURE }),
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: judgeUserMessage(input) }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.ok) {
      const body = (await response.json()) as {
        content: { type: string; text?: string }[];
      };
      const text = body.content.map((part) => part.text ?? '').join('');
      try {
        return parseJudgement(text);
      } catch (error) {
        // One malformed reply should not end a run of sixty: ask again.
        if (attempt >= 4) {
          throw error;
        }
        continue;
      }
    }
    // The key never appears in an error: only status and body are reported.
    if (
      attempt >= 4 ||
      ![408, 429, 500, 502, 503, 529].includes(response.status)
    ) {
      throw new Error(
        `Judge request failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
}

interface Judged {
  question: string;
  kind: string;
  abstained: boolean;
  judgement: Judgement | null;
}
const judged: Judged[] = [];
for (const record of run.answers) {
  const question = questions.get(record.question);
  if (!question || record.status === 'error' || record.status === 'failed') {
    continue;
  }
  if (record.abstained || !record.answer) {
    judged.push({
      question: record.question,
      kind: record.kind,
      abstained: true,
      judgement: null,
    });
    continue;
  }
  const excerpts = record.citations.map((citation) => ({
    marker: citation.marker,
    text: run.chunks[citation.chunkId] ?? '(excerpt no longer in the database)',
  }));
  const judgement = await judge({
    question: question.question,
    answer: record.answer,
    excerpts,
    reference: reference(question),
  });
  judged.push({
    question: record.question,
    kind: record.kind,
    abstained: false,
    judgement,
  });
  process.stdout.write('.');
}
process.stdout.write('\n');

// ── Metrics (§9.3) ───────────────────────────────────────────────────────────
const answered = judged.filter((j) => j.judgement);
const claims = answered.flatMap((j) => (j.judgement as Judgement).claims);
// Groundedness asks whether what the answer says about the contracts is
// backed by an excerpt; "the excerpts do not mention X" cannot be cited.
const facts = claims.filter((claim) => claim.kind === 'fact');
const grounded = facts.filter((claim) =>
  claim.markers.some((m) => m.supports === 'yes'),
);
const pairs = claims.flatMap((claim) => claim.markers);
const answerable = judged.filter((j) => j.kind === 'answerable');
const unanswerable = judged.filter((j) => j.kind !== 'answerable');
const rate = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;
// The system abstains when it sends no answer or the answer cites nothing.
// An answer that says "not in the documents" in words but cites a side
// remark is, for the user, an abstention too — reported both ways.
const declines = (j: Judged): boolean =>
  j.abstained || j.judgement?.declines === 'yes';

const metrics = {
  groundedness: rate(grounded.length, facts.length),
  citationAccuracy: rate(
    pairs.filter((pair) => pair.supports === 'yes').length,
    pairs.length,
  ),
  correctAbstention: rate(
    unanswerable.filter(declines).length,
    unanswerable.length,
  ),
  falseAbstention: rate(answerable.filter(declines).length, answerable.length),
  systemCorrectAbstention: rate(
    unanswerable.filter((j) => j.abstained).length,
    unanswerable.length,
  ),
  systemFalseAbstention: rate(
    answerable.filter((j) => j.abstained).length,
    answerable.length,
  ),
  answerCorrect: rate(
    answerable.filter((j) => j.judgement?.correct === 'yes').length,
    answerable.length,
  ),
  answerPartial: rate(
    answerable.filter((j) => j.judgement?.correct === 'partial').length,
    answerable.length,
  ),
  counts: {
    answers: judged.length,
    answered: answered.length,
    claims: claims.length,
    factClaims: facts.length,
    citationPairs: pairs.length,
    answerable: answerable.length,
    unanswerable: unanswerable.length,
  },
};

const dir = resultsDir(experiment);
writeJson(join(dir, `judge-${label}.json`), {
  run: basename(runFile),
  judge: {
    model: MODEL,
    temperature: TEMPERATURE ?? null,
    prompt: JUDGE_PROMPT_VERSION,
  },
  metrics,
  judged,
});

// A seeded sample of (claim, marker) verdicts for the author: column
// `author` is left empty, to be filled with yes/no.
const random = seededRandom(23);
const rows = answered.flatMap((j) =>
  (j.judgement as Judgement).claims.flatMap((claim) =>
    claim.markers.map((marker) => ({
      question: j.question,
      claim: claim.text,
      marker,
    })),
  ),
);
const record = (questionId: string) =>
  run.answers.find((a) => a.question === questionId);
const sample = shuffled(rows, random)
  .slice(0, Math.ceil(rows.length * SAMPLE))
  .map((row) => {
    const citation = record(row.question)?.citations.find(
      (c) => c.marker === row.marker.n,
    );
    return {
      question: row.question,
      claim: row.claim,
      marker: row.marker.n,
      excerpt: citation
        ? (run.chunks[citation.chunkId] ?? '').replace(/\s+/g, ' ')
        : '',
      judge: row.marker.supports,
      author: '',
    };
  });
writeText(join(dir, `judge-sample-${label}.csv`), toCsv(sample));

const pct = (value: number | null): string =>
  value === null ? '—' : `${(100 * value).toFixed(1)} %`;
console.log(
  [
    `Groundedness ${pct(metrics.groundedness)}, citation accuracy ${pct(metrics.citationAccuracy)}`,
    `Abstention: correct ${pct(metrics.correctAbstention)}, false ${pct(metrics.falseAbstention)} (system's own flag: ${pct(metrics.systemCorrectAbstention)}, ${pct(metrics.systemFalseAbstention)})`,
    `Answer correct ${pct(metrics.answerCorrect)}, partial ${pct(metrics.answerPartial)}`,
    `Sample for manual grading: ${sample.length} verdicts → judge-sample-${label}.csv`,
  ].join('\n'),
);
