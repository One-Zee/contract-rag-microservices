// Uploads the chosen contracts through the gateway as one evaluation account
// and waits until every one is indexed (or failed).
//
//   npm run eval:corpus
//
// Needs the stack running against the evaluation database (eval/README.md).
// Idempotent: a contract already uploaded under its id is not uploaded again.
import { join } from 'node:path';
import { pdfPath } from '../lib/cuad.ts';
import { Gateway, HttpError } from '../lib/api.ts';
import { type ContractEntry, loadContracts } from '../lib/dataset.ts';
import { withDb } from '../lib/db.ts';
import { args, experimentName, gatewayUrl, loadEnv } from '../lib/env.ts';
import { readJson, writeJson } from '../lib/json.ts';
import { resultsDir } from '../lib/paths.ts';
import { runInfo } from '../lib/run-info.ts';
import { documentLabel } from '../lib/templates.ts';

loadEnv();
const options = args();
const experiment = experimentName();
const email = process.env.EVAL_EMAIL ?? 'evaluation@clauseiq.test';
const password = process.env.EVAL_PASSWORD ?? 'evaluation-only-password';
const TIMEOUT_MS = Number(process.env.EVAL_INDEX_TIMEOUT_MS ?? 60 * 60_000);

const gateway = new Gateway(gatewayUrl());
try {
  await gateway.register(email, password);
  console.log(`Registered ${email}`);
} catch (error) {
  if (!(error instanceof HttpError && error.status === 409)) {
    throw error;
  }
}

// Registration always yields `reader`, and uploading takes `analyst`; there is
// no API for roles by design, so the harness sets it directly.
await withDb((db) =>
  db.query(`UPDATE users SET role = 'analyst' WHERE email = $1`, [email]),
);
await gateway.login(email, password);

// `--contracts a.json,b.json` for a corpus other than the evaluation one (the
// load tests' — eval/load/run-load.ts seed).
const contracts: ContractEntry[] = options.has('contracts')
  ? String(options.get('contracts'))
      .split(',')
      .flatMap((file) => readJson<ContractEntry[]>(file))
  : loadContracts();
const existing = new Map<string, string>();
for (let page = 1; ; page++) {
  const { items, total } = await gateway.documents(page, 100);
  for (const item of items) {
    existing.set(item.title.split(' ')[0], item.id);
  }
  if (page * 100 >= total) {
    break;
  }
}

const documentIds = new Map<string, string>();
for (const contract of contracts) {
  const known = existing.get(contract.id);
  if (known) {
    documentIds.set(contract.id, known);
    continue;
  }
  const title = `${contract.id} ${documentLabel(contract.documentName)}`.slice(
    0,
    200,
  );
  const document = await gateway.upload(pdfPath(contract), title);
  documentIds.set(contract.id, document.id);
  console.log(`Uploaded ${contract.id} → ${document.id}`);
}

const startedAt = Date.now();
const settled = new Map<string, Awaited<ReturnType<Gateway['status']>>>();
while (settled.size < contracts.length) {
  if (Date.now() - startedAt > TIMEOUT_MS) {
    throw new Error(`Not indexed after ${TIMEOUT_MS / 60_000} min`);
  }
  for (const contract of contracts) {
    if (settled.has(contract.id)) {
      continue;
    }
    const status = await gateway.status(documentIds.get(contract.id) as string);
    if (status.status === 'indexed' || status.status === 'failed') {
      settled.set(contract.id, status);
    }
  }
  console.log(`  ${settled.size}/${contracts.length} settled`);
  if (settled.size < contracts.length) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const corpus = contracts.map((contract) => {
  const status = settled.get(contract.id);
  return {
    contract: contract.id,
    documentId: documentIds.get(contract.id),
    status: status?.status,
    pages: status?.pageCount,
    chunks: status?.chunkCount,
    error: status?.errorMessage ?? null,
  };
});
// Document ids are this database's: local state, not a result.
const file = join(resultsDir(experiment, 'raw'), 'corpus.json');
writeJson(file, { info: runInfo(experiment), documents: corpus });

const failed = corpus.filter((entry) => entry.status !== 'indexed');
const chunks = corpus.reduce((sum, entry) => sum + (entry.chunks ?? 0), 0);
console.log(
  `${corpus.length - failed.length} indexed, ${failed.length} failed, ${chunks} chunks → ${file}`,
);
for (const entry of failed) {
  console.log(`  failed: ${entry.contract} ${entry.error}`);
}
