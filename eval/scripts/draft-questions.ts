// Drafts the question set from CUAD's annotations for the chosen contracts.
//
//   npm run eval:draft [-- --answerable 50 --absent 6 --out-of-corpus 4 --seed 7]
//
// Writes eval/dataset/questions.json with "status": "draft". The author
// rewrites the wording and sets "reviewed" (§9.1); the gold spans stay put.
import { existsSync } from 'node:fs';
import { type CuadContract, loadCuad } from '../lib/cuad.ts';
import {
  loadContracts,
  type Question,
  type QuestionSet,
} from '../lib/dataset.ts';
import { args } from '../lib/env.ts';
import { readJson, writeJson } from '../lib/json.ts';
import { QUESTIONS_FILE } from '../lib/paths.ts';
import { seededRandom, shuffled } from '../lib/random.ts';
import {
  ABSENT_TEMPLATES,
  ANSWERABLE_TEMPLATES,
  documentLabel,
  partiesLabel,
  type Template,
} from '../lib/templates.ts';
import { tokens } from '../lib/text.ts';

const options = args();
const ANSWERABLE = Number(options.get('answerable') ?? 50);
const ABSENT = Number(options.get('absent') ?? 6);
const OUT_OF_CORPUS = Number(options.get('out-of-corpus') ?? 4);
const SEED = Number(options.get('seed') ?? 7);

if (existsSync(QUESTIONS_FILE) && !options.has('force')) {
  const current = readJson<QuestionSet>(QUESTIONS_FILE);
  if (current.status === 'reviewed') {
    throw new Error(
      'questions.json is reviewed; refusing to overwrite it (--force)',
    );
  }
}

// A span of two words ("Delaware") pins down nothing, and a span of a whole
// page is a section, not an answer.
const MIN_SPAN_WORDS = 3;
const MAX_SPAN_WORDS = 300;

const random = seededRandom(SEED);
const corpus = loadContracts();
const cuad = new Map(loadCuad().map((contract) => [contract.title, contract]));
const usage = new Map<string, number>();

function usable(contract: CuadContract, category: string): boolean {
  const spans = contract.clauses.get(category) ?? [];
  const words = spans.reduce((sum, span) => sum + tokens(span.text).length, 0);
  return spans.length > 0 && words >= MIN_SPAN_WORDS && words <= MAX_SPAN_WORDS;
}

/** The least used category first, so the set does not become 40 governing-law questions. */
function pick(categories: string[]): string | undefined {
  const ranked = shuffled(categories, random).sort(
    (a, b) => (usage.get(a) ?? 0) - (usage.get(b) ?? 0),
  );
  const category = ranked[0];
  if (category) {
    usage.set(category, (usage.get(category) ?? 0) + 1);
  }
  return category;
}

function phrase(
  template: Template,
  documentName: string,
  parties: string[],
): string {
  return template(documentLabel(documentName), partiesLabel(parties));
}

const questions: Omit<Question, 'id'>[] = [];
const asked = new Map<string, Set<string>>();

function addAnswerable(entryId: string, contract: CuadContract): boolean {
  const done = asked.get(entryId) ?? new Set<string>();
  const category = pick(
    Object.keys(ANSWERABLE_TEMPLATES).filter(
      (c) => !done.has(c) && usable(contract, c),
    ),
  );
  if (!category) {
    return false;
  }
  done.add(category);
  asked.set(entryId, done);
  questions.push({
    kind: 'answerable',
    contract: entryId,
    category,
    question: phrase(
      ANSWERABLE_TEMPLATES[category],
      contract.documentName,
      contract.parties,
    ),
    gold: contract.clauses.get(category) ?? [],
    normalized: contract.normalized.get(category.toLowerCase()) ?? '',
  });
  return true;
}

// Every contract gets one question, then a seeded subset a second one.
for (const entry of corpus) {
  addAnswerable(entry.id, cuad.get(entry.title) as CuadContract);
}
for (const entry of shuffled(corpus, random)) {
  if (questions.length >= ANSWERABLE) {
    break;
  }
  addAnswerable(entry.id, cuad.get(entry.title) as CuadContract);
}

let absent = 0;
for (const entry of shuffled(corpus, random)) {
  if (absent >= ABSENT) {
    break;
  }
  const contract = cuad.get(entry.title) as CuadContract;
  const category = pick(
    Object.keys(ABSENT_TEMPLATES).filter(
      (c) =>
        contract.clauses.has(c) && (contract.clauses.get(c) ?? []).length === 0,
    ),
  );
  if (!category) {
    continue;
  }
  questions.push({
    kind: 'absent',
    contract: entry.id,
    category,
    question: phrase(
      ABSENT_TEMPLATES[category],
      contract.documentName,
      contract.parties,
    ),
    gold: [],
    normalized: contract.normalized.get(category.toLowerCase()) ?? '',
  });
  absent++;
}

// Questions a user could reasonably ask, about contracts nobody uploaded.
const inCorpus = new Set(corpus.map((entry) => entry.title));
const outside = shuffled(
  [...cuad.values()].filter(
    (contract) =>
      !inCorpus.has(contract.title) &&
      contract.parties.length >= 2 &&
      usable(contract, 'Governing Law'),
  ),
  random,
).slice(0, OUT_OF_CORPUS);
for (const contract of outside) {
  questions.push({
    kind: 'out_of_corpus',
    contract: contract.title,
    category: 'Governing Law',
    question: phrase(
      ANSWERABLE_TEMPLATES['Governing Law'],
      contract.documentName,
      contract.parties,
    ),
    gold: [],
    normalized: contract.normalized.get('governing law') ?? '',
  });
}

const set: QuestionSet = {
  status: 'draft',
  note: 'Drafted from CUAD annotations by eval/scripts/draft-questions.ts. Review the wording of each question, keep id/contract/category/gold as they are, then set status to "reviewed".',
  questions: questions.map((question, i) => ({
    id: `q${String(i + 1).padStart(2, '0')}`,
    ...question,
  })),
};
writeJson(QUESTIONS_FILE, set);

const counts = new Map<string, number>();
for (const question of set.questions) {
  counts.set(question.kind, (counts.get(question.kind) ?? 0) + 1);
}
console.log(
  `Drafted ${set.questions.length} questions: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}`,
);
console.log(
  `Categories: ${[...usage]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c} ${n}`)
    .join(', ')}`,
);
console.log(`Wrote ${QUESTIONS_FILE}`);
