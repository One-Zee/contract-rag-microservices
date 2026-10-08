import { existsSync } from 'node:fs';
import type { CuadSpan } from './cuad.ts';
import { readJson } from './json.ts';
import { CONTRACTS_FILE, QUESTIONS_FILE } from './paths.ts';

export interface ContractEntry {
  /** `c01`…: what results and questions refer to. */
  id: string;
  /** CUAD's id of the contract. */
  title: string;
  /** Relative to `full_contract_pdf/`. */
  pdf: string;
  sha256: string;
  type: string;
  pages: number;
  documentName: string;
  parties: string[];
}

/**
 * - `answerable`: CUAD annotates the answer in a corpus contract.
 * - `absent`: the contract is in the corpus, the clause is not in it.
 * - `out_of_corpus`: the contract itself was never uploaded.
 *
 * The last two are what the abstention rate (§9.3) is measured on.
 */
export type QuestionKind = 'answerable' | 'absent' | 'out_of_corpus';

export interface Question {
  id: string;
  kind: QuestionKind;
  /** A contract id for corpus contracts, CUAD's title for `out_of_corpus`. */
  contract: string;
  category: string;
  question: string;
  /** CUAD's spans — the ground truth retrieval is scored against. */
  gold: CuadSpan[];
  /** CUAD's normalised answer, e.g. "Delaware" or "Yes"; may be empty. */
  normalized: string;
}

export interface QuestionSet {
  /** `draft` until the author has reviewed the wording (§9.1). */
  status: 'draft' | 'reviewed';
  note: string;
  questions: Question[];
}

export function loadContracts(): ContractEntry[] {
  if (!existsSync(CONTRACTS_FILE)) {
    throw new Error('eval/dataset/contracts.json is missing — run eval:select');
  }
  return readJson<ContractEntry[]>(CONTRACTS_FILE);
}

/**
 * Final numbers are only ever computed on a reviewed set. A draft is fine for
 * developing the harness, and `--allow-draft` says so explicitly.
 */
export function loadQuestions(allowDraft: boolean): QuestionSet {
  if (!existsSync(QUESTIONS_FILE)) {
    throw new Error('eval/dataset/questions.json is missing — run eval:draft');
  }
  const set = readJson<QuestionSet>(QUESTIONS_FILE);
  if (set.status !== 'reviewed' && !allowDraft) {
    throw new Error(
      'questions.json is still a draft: review it and set "status": "reviewed", or pass --allow-draft',
    );
  }
  return set;
}
