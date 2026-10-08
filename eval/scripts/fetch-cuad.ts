// Downloads CUAD v1 from Zenodo into eval/data/ (gitignored) and unpacks it.
// Idempotent: a zip with the right checksum is not downloaded again.
//
//   npm run eval:fetch
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { CUAD_DIR, DATA_DIR } from '../lib/paths.ts';

const SOURCE =
  'https://zenodo.org/records/4595826/files/CUAD_v1.zip?download=1';
// Pinned on the first download (2026-10-04). A different file is a different
// dataset, and every number in the thesis would silently refer to it.
const SHA256 =
  '88b694d99007d39777fa44cd72daf8297773d285dc3eab0091ba32078888d18e';
const ZIP = join(DATA_DIR, 'CUAD_v1.zip');

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

mkdirSync(DATA_DIR, { recursive: true });

if (!existsSync(ZIP) || (await sha256(ZIP)) !== SHA256) {
  console.log(`Downloading ${SOURCE}`);
  const response = await fetch(SOURCE);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    createWriteStream(ZIP),
  );
  const actual = await sha256(ZIP);
  if (actual !== SHA256) {
    throw new Error(`Checksum mismatch: expected ${SHA256}, got ${actual}`);
  }
}
console.log(`CUAD_v1.zip ok (sha256 ${SHA256.slice(0, 12)}…)`);

if (!existsSync(join(CUAD_DIR, 'CUAD_v1.json'))) {
  const unzip = spawnSync('unzip', ['-q', '-o', ZIP, '-d', DATA_DIR], {
    stdio: 'inherit',
  });
  if (unzip.status !== 0) {
    throw new Error('unzip failed');
  }
}
console.log(`Unpacked into ${CUAD_DIR}`);
