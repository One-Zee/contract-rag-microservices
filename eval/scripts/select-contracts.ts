// Chooses the evaluation corpus from CUAD: a fixed number of contracts,
// stratified by contract type, deterministic for a given seed.
//
//   npm run eval:select [-- --count 40 --seed 7]
//
// Writes eval/dataset/contracts.json (committed). PDF statistics are cached
// in eval/data/pdf-stats.json, since reading 510 PDFs takes minutes.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type CuadContract, loadCuad, pdfPath } from '../lib/cuad.ts';
import type { ContractEntry } from '../lib/dataset.ts';
import { args } from '../lib/env.ts';
import { readJson, writeJson } from '../lib/json.ts';
import { CONTRACTS_FILE, DATA_DIR } from '../lib/paths.ts';
import { type PdfStats, pdfStats } from '../lib/pdf.ts';
import { seededRandom, shuffled } from '../lib/random.ts';
import { ANSWERABLE_TEMPLATES } from '../lib/templates.ts';

const options = args();
const COUNT = Number(options.get('count') ?? 40);
const SEED = Number(options.get('seed') ?? 7);
// The load-test corpus is the evaluation corpus plus more contracts:
// `--out eval/dataset/load-contracts.json --exclude eval/dataset/contracts.json
// --prefix l --count 160`.
const OUT = String(options.get('out') ?? CONTRACTS_FILE);
const PREFIX = String(options.get('prefix') ?? 'c');
const EXCLUDED = new Set(
  options.has('exclude')
    ? readJson<ContractEntry[]>(String(options.get('exclude'))).map(
        (entry) => entry.title,
      )
    : [],
);

// Short contracts make retrieval trivial — with a handful of chunks every
// chunk is in the top 10 — and very long ones are mostly exhibits.
const MIN_PAGES = 5;
const MAX_PAGES = 60;
// Below this many non-blank characters per page there is no text layer worth
// the name (a scan), and the system would record the document as failed.
const MIN_CHARS_PER_PAGE = 800;
// A contract must be able to carry a question of its own, preferably two.
const MIN_ANSWERABLE = 2;

const STATS_CACHE = join(DATA_DIR, 'pdf-stats.json');
const cache: Record<string, PdfStats | { error: string }> = existsSync(
  STATS_CACHE,
)
  ? readJson(STATS_CACHE)
  : {};

const contracts = loadCuad().sort((a, b) => a.title.localeCompare(b.title));
console.log(`CUAD: ${contracts.length} contracts`);

let done = 0;
for (const contract of contracts) {
  if (!cache[contract.title]) {
    try {
      cache[contract.title] = await pdfStats(pdfPath(contract));
    } catch (error) {
      cache[contract.title] = { error: String(error) };
    }
  }
  if (++done % 50 === 0) {
    console.log(`  read ${done}/${contracts.length} PDFs`);
    writeJson(STATS_CACHE, cache);
  }
}
writeJson(STATS_CACHE, cache);

const answerable = (contract: CuadContract): number =>
  Object.keys(ANSWERABLE_TEMPLATES).filter(
    (category) => (contract.clauses.get(category)?.length ?? 0) > 0,
  ).length;

const eligible = contracts.filter((contract) => {
  if (EXCLUDED.has(contract.title)) {
    return false;
  }
  const stats = cache[contract.title];
  return (
    stats &&
    !('error' in stats) &&
    stats.pages >= MIN_PAGES &&
    stats.pages <= MAX_PAGES &&
    stats.chars / stats.pages >= MIN_CHARS_PER_PAGE &&
    contract.parties.length >= 2 &&
    answerable(contract) >= MIN_ANSWERABLE
  );
});
console.log(`Eligible: ${eligible.length}`);

// Round-robin over the types, in a seeded order, so every type is represented
// before any type gets a second contract.
const random = seededRandom(SEED);
const byType = new Map<string, CuadContract[]>();
for (const contract of eligible) {
  byType.set(contract.type, [...(byType.get(contract.type) ?? []), contract]);
}
const queues = shuffled([...byType.keys()].sort(), random).map((type) =>
  shuffled(byType.get(type) ?? [], random),
);
const chosen: CuadContract[] = [];
while (chosen.length < COUNT && queues.some((queue) => queue.length > 0)) {
  for (const queue of queues) {
    const next = queue.shift();
    if (next && chosen.length < COUNT) {
      chosen.push(next);
    }
  }
}

const entries: ContractEntry[] = chosen.map((contract, i) => {
  const stats = cache[contract.title] as PdfStats;
  return {
    id: `${PREFIX}${String(i + 1).padStart(COUNT > 99 ? 3 : 2, '0')}`,
    title: contract.title,
    pdf: contract.pdf,
    sha256: stats.sha256,
    type: contract.type,
    pages: stats.pages,
    documentName: contract.documentName,
    parties: contract.parties,
  };
});
writeJson(OUT, entries);

const types = new Set(entries.map((entry) => entry.type));
const pages = entries.map((entry) => entry.pages).sort((a, b) => a - b);
console.log(
  `Chose ${entries.length} contracts across ${types.size} types; pages ${pages[0]}–${pages.at(-1)}, median ${pages[Math.floor(pages.length / 2)]}`,
);
console.log(`Wrote ${OUT}`);
