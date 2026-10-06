import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { parseCsvRecords } from './csv.ts';
import { CUAD_DIR } from './paths.ts';

/**
 * CUAD v1 (Hendrycks et al., NeurIPS 2021; CC BY 4.0): 510 commercial
 * contracts, each annotated with the spans that answer 41 clause categories.
 * Three files describe one contract: the PDF the system ingests, the text
 * CUAD annotated (`CUAD_v1.json`, SQuAD format — offsets point into it), and a
 * row of normalised answers (`master_clauses.csv`, e.g. "Delaware").
 */

export interface CuadSpan {
  text: string;
  /** Character offset into `CuadContract.context`. */
  start: number;
}

export interface CuadContract {
  /** CUAD's id: the file name without its extension. */
  title: string;
  /** Relative to `full_contract_pdf/`. */
  pdf: string;
  /** Contract type from the folder, with CUAD's spelling variants merged. */
  type: string;
  /** The text CUAD annotated — not the text pdf-parse extracts. */
  context: string;
  /** Spans per category; an empty list means the clause is absent. */
  clauses: Map<string, CuadSpan[]>;
  /** `master_clauses.csv`, keyed by category: the normalised answer. */
  normalized: Map<string, string>;
  documentName: string;
  parties: string[];
}

interface SquadFile {
  data: {
    title: string;
    paragraphs: {
      context: string;
      qas: {
        id: string;
        is_impossible?: boolean;
        answers: { text: string; answer_start: number }[];
      }[];
    }[];
  }[];
}

/**
 * The JSON, the PDF names and the CSV spell one contract differently
 * ("A&R" / "A_R", "MACY'S" / "MACY_S", "É", a trailing "-"), so they are
 * joined on letters and digits alone.
 */
const matchKey = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const stem = (file: string): string => matchKey(basename(file, extname(file)));

/** Exact key, else the one key that extends it ("…Development Agreement_Option Agreement"). */
function lookup<T>(map: Map<string, T>, key: string): T | undefined {
  const exact = map.get(key);
  if (exact !== undefined) {
    return exact;
  }
  const candidates = [...map.keys()].filter(
    (other) => other.startsWith(key) || key.startsWith(other),
  );
  return candidates.length === 1 ? map.get(candidates[0]) : undefined;
}

function canonicalType(folder: string): string {
  return folder
    .replace(/_/g, ' ')
    .replace(/\s+filing$/i, '')
    .replace(/\s+agreements?$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findPdfs(): Map<string, { pdf: string; type: string }> {
  const root = join(CUAD_DIR, 'full_contract_pdf');
  const found = new Map<string, { pdf: string; type: string }>();
  const walk = (dir: string, type: string | null): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        // Part_I/<Type>/… — the part folders carry no meaning of their own.
        walk(path, entry.startsWith('Part_') ? null : canonicalType(entry));
      } else if (extname(entry).toLowerCase() === '.pdf') {
        found.set(stem(entry), {
          pdf: relative(root, path),
          type: type ?? 'other',
        });
      }
    }
  };
  walk(root, null);
  return found;
}

/** `Acme Inc. ("Acme"); Beta LLC ("Distributor")` → the two names, no defined terms. */
export function parseParties(answer: string): string[] {
  return answer
    .replace(/ /g, ' ')
    .split(';')
    .map((party) =>
      party
        .replace(/\s*\(.*$/s, '')
        .replace(/["“”]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/,$/, '')
        .trim(),
    )
    .filter((party) => party.length > 1);
}

/** `master_clauses.csv` spells one header "…Renewal- Answer"; normalise them all. */
function normalizedColumns(row: Record<string, string>): Map<string, string> {
  const answers = new Map<string, string>();
  for (const [header, value] of Object.entries(row)) {
    const match = /^(.*?)\s*-\s*Answer$/.exec(header);
    if (match) {
      answers.set(
        match[1].trim().toLowerCase(),
        value.replace(/ /g, ' ').trim(),
      );
    }
  }
  return answers;
}

export function loadCuad(): CuadContract[] {
  const squad = JSON.parse(
    readFileSync(join(CUAD_DIR, 'CUAD_v1.json'), 'utf8'),
  ) as SquadFile;
  const master = new Map(
    parseCsvRecords(
      readFileSync(join(CUAD_DIR, 'master_clauses.csv'), 'utf8'),
    ).map((row) => [stem(row.Filename), row]),
  );
  const pdfs = findPdfs();

  const contracts: CuadContract[] = [];
  for (const entry of squad.data) {
    const key = matchKey(entry.title);
    const pdf = lookup(pdfs, key);
    const row = lookup(master, key);
    if (!pdf || !row) {
      continue;
    }
    const paragraph = entry.paragraphs[0];
    const clauses = new Map<string, CuadSpan[]>();
    for (const qa of paragraph.qas) {
      const category = qa.id.slice(qa.id.lastIndexOf('__') + 2);
      clauses.set(
        category,
        qa.is_impossible
          ? []
          : qa.answers.map((a) => ({ text: a.text, start: a.answer_start })),
      );
    }
    const normalized = normalizedColumns(row);
    contracts.push({
      title: entry.title,
      pdf: pdf.pdf,
      type: pdf.type,
      context: paragraph.context,
      clauses,
      normalized,
      documentName: normalized.get('document name') ?? entry.title,
      parties: parseParties(normalized.get('parties') ?? ''),
    });
  }
  return contracts;
}

export const pdfPath = (contract: { pdf: string }): string =>
  join(CUAD_DIR, 'full_contract_pdf', contract.pdf);
