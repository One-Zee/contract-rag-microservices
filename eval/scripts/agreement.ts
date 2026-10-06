// Agreement between the judge and the author on the hand-graded sample:
// raw agreement and Cohen's κ (chance-corrected).
//
//   npm run eval:agreement [-- --label t0]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvRecords } from '../lib/csv.ts';
import { args, experimentName, loadEnv } from '../lib/env.ts';
import { writeJson } from '../lib/json.ts';
import { resultsDir } from '../lib/paths.ts';

loadEnv();
const options = args();
const experiment = experimentName();
const label = String(options.get('label') ?? 'run');
const dir = resultsDir(experiment);

const rows = parseCsvRecords(
  readFileSync(join(dir, `judge-sample-${label}.csv`), 'utf8'),
)
  .map((row) => ({
    judge: row.judge.trim().toLowerCase(),
    author: row.author.trim().toLowerCase(),
  }))
  .filter((row) => row.author === 'yes' || row.author === 'no');
if (rows.length === 0) {
  throw new Error('No graded rows: fill the `author` column with yes/no first');
}

const agree =
  rows.filter((row) => row.judge === row.author).length / rows.length;
const p = (who: 'judge' | 'author') =>
  rows.filter((row) => row[who] === 'yes').length / rows.length;
const chance = p('judge') * p('author') + (1 - p('judge')) * (1 - p('author'));
const kappa = chance === 1 ? 1 : (agree - chance) / (1 - chance);

writeJson(join(dir, `agreement-${label}.json`), {
  graded: rows.length,
  agreement: agree,
  kappa,
});
console.log(
  `${rows.length} verdicts graded: agreement ${(100 * agree).toFixed(1)} %, Cohen's κ ${kappa.toFixed(2)}`,
);
