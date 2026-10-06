// Turns CUAD's gold spans into graded chunk labels for one evaluation
// database — the qrels every retrieval metric is computed against.
//
//   npm run eval:label [-- --allow-draft]
//
// Matching is on word 4-grams: CUAD annotated its own text, the
// system extracted its own, and the two differ in line breaks, hyphenation
// and page furniture. A chunk's grade for a span is the share of the span's
// 4-grams it contains: ≥ 0.9 → 2 (the whole span), ≥ 0.4 → 1 (part of it).
// Spans shorter than a few words ("Delaware") are anchored by the words
// around them in CUAD's text, and the chunk must then contain the span itself.
import { join } from 'node:path';
import { loadCuad } from '../lib/cuad.ts';
import { loadContracts, loadQuestions } from '../lib/dataset.ts';
import { withDb } from '../lib/db.ts';
import { args, experimentName, loadEnv } from '../lib/env.ts';
import { readJson, writeJson, writeText } from '../lib/json.ts';
import type { SpanLabel } from '../lib/metrics.ts';
import { resultsDir } from '../lib/paths.ts';
import { runInfo } from '../lib/run-info.ts';
import { longestCommonRun, tokens } from '../lib/text.ts';

loadEnv();
const options = args();
const experiment = experimentName();
const N = 4;
const FULL = 0.9;
const PARTIAL = 0.4;
const SHORT_SPAN = 8;
const ANCHOR_CHARS = 120;

const grams = (words: readonly string[]): Set<string> => {
  const set = new Set<string>();
  for (let i = 0; i + N <= words.length; i++) {
    set.add(words.slice(i, i + N).join(' '));
  }
  return set;
};

const coverage = (span: Set<string>, chunk: Set<string>): number => {
  if (span.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const gram of span) {
    if (chunk.has(gram)) {
      hits++;
    }
  }
  return hits / span.size;
};

const questions = loadQuestions(options.has('allow-draft')).questions.filter(
  (question) => question.kind === 'answerable',
);
const contracts = new Map(loadContracts().map((entry) => [entry.id, entry]));
const cuad = new Map(loadCuad().map((contract) => [contract.title, contract]));
const corpus = readJson<{
  documents: { contract: string; documentId: string; status: string }[];
}>(join(resultsDir(experiment, 'raw'), 'corpus.json')).documents;
const documentOf = new Map(corpus.map((entry) => [entry.contract, entry]));

interface LabelledSpan extends SpanLabel {
  text: string;
  best: number;
}
const labels: Record<string, { documentId: string; spans: LabelledSpan[] }> =
  {};
const unmatched: { question: string; span: string; best: number }[] = [];
let spanCount = 0;

await withDb(async (db) => {
  for (const question of questions) {
    const document = documentOf.get(question.contract);
    if (!document || document.status !== 'indexed') {
      continue;
    }
    const entry = contracts.get(question.contract);
    const source = entry ? cuad.get(entry.title) : undefined;
    const { rows } = await db.query<{ id: string; content: string }>(
      'SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY chunk_index',
      [document.documentId],
    );
    const chunks = rows.map((row) => {
      const words = tokens(row.content);
      return { id: row.id, words, grams: grams(words) };
    });

    const spans: LabelledSpan[] = [];
    for (const span of question.gold) {
      spanCount++;
      const core = tokens(span.text);
      const short = core.length < SHORT_SPAN;
      const anchorText =
        short && source
          ? source.context.slice(
              Math.max(0, span.start - ANCHOR_CHARS),
              span.start + span.text.length + ANCHOR_CHARS,
            )
          : span.text;
      const anchor = grams(tokens(anchorText));

      const graded: Record<string, number> = {};
      let best = 0;
      for (const chunk of chunks) {
        if (short && longestCommonRun(core, chunk.words) < core.length) {
          continue;
        }
        const share = coverage(anchor, chunk.grams);
        best = Math.max(best, share);
        if (share >= FULL) {
          graded[chunk.id] = 2;
        } else if (share >= PARTIAL) {
          graded[chunk.id] = 1;
        }
      }
      if (Object.keys(graded).length === 0) {
        unmatched.push({
          question: question.id,
          span: span.text.slice(0, 160),
          best,
        });
        continue;
      }
      spans.push({ text: span.text.slice(0, 160), chunks: graded, best });
    }
    labels[question.id] = { documentId: document.documentId, spans };
  }
});

const dir = resultsDir(experiment);
// Chunk ids are this database's: local state, not a result (raw/ is gitignored).
writeJson(join(resultsDir(experiment, 'raw'), 'labels.json'), {
  info: runInfo(experiment),
  labels,
});

const matched = spanCount - unmatched.length;
const lines = [
  `# Labels — ${experiment}`,
  '',
  `${matched} of ${spanCount} gold spans matched to at least one chunk (${((100 * matched) / Math.max(spanCount, 1)).toFixed(1)} %).`,
  `${Object.values(labels).filter((label) => label.spans.length === 0).length} questions have no matched span and drop out of the retrieval metrics.`,
  '',
  '| question | best 4-gram coverage | span |',
  '|---|---|---|',
  ...unmatched.map(
    (miss) =>
      `| ${miss.question} | ${miss.best.toFixed(2)} | ${miss.span.replace(/\|/g, '/').replace(/\s+/g, ' ')} |`,
  ),
];
writeText(join(dir, 'labels.md'), `${lines.join('\n')}\n`);
console.log(lines.slice(2, 4).join('\n'));
