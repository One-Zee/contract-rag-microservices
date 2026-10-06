/**
 * The question a user would type for a CUAD category. Every question names
 * the contract and its parties: the corpus holds 40 contracts, and "what is
 * the governing law?" has 40 right answers.
 *
 * These are a draft. The author rewrites the wording during review (§9.1:
 * the questions are prepared by hand); the gold spans stay attached by id.
 */
export type Template = (doc: string, parties: string) => string;

export const ANSWERABLE_TEMPLATES: Record<string, Template> = {
  'Governing Law': (doc, parties) =>
    `Which jurisdiction's law governs the ${doc} between ${parties}?`,
  'Expiration Date': (doc, parties) =>
    `When does the ${doc} between ${parties} expire?`,
  'Renewal Term': (doc, parties) =>
    `How does the ${doc} between ${parties} renew after its initial term?`,
  'Notice Period To Terminate Renewal': (doc, parties) =>
    `How much notice is needed to stop the ${doc} between ${parties} from renewing?`,
  'Termination For Convenience': (doc, parties) =>
    `Can the ${doc} between ${parties} be terminated without cause, and on what notice?`,
  'Cap On Liability': (doc, parties) =>
    `How is liability limited under the ${doc} between ${parties}?`,
  'Non-Compete': (doc, parties) =>
    `What non-compete restrictions does the ${doc} between ${parties} impose?`,
  Exclusivity: (doc, parties) =>
    `What exclusivity does the ${doc} between ${parties} grant?`,
  'Audit Rights': (doc, parties) =>
    `What audit rights does the ${doc} between ${parties} provide?`,
  Insurance: (doc, parties) =>
    `What insurance must be maintained under the ${doc} between ${parties}?`,
  'Anti-Assignment': (doc, parties) =>
    `Can the ${doc} between ${parties} be assigned without the other party's consent?`,
  'License Grant': (doc, parties) =>
    `What license is granted under the ${doc} between ${parties}?`,
  'Warranty Duration': (doc, parties) =>
    `How long is the warranty period under the ${doc} between ${parties}?`,
  'Minimum Commitment': (doc, parties) =>
    `What minimum commitment does the ${doc} between ${parties} require?`,
  'Post-Termination Services': (doc, parties) =>
    `What obligations continue after the ${doc} between ${parties} ends?`,
};

/** Yes/no clauses whose absence CUAD records — the `absent` questions. */
export const ABSENT_TEMPLATES: Record<string, Template> = {
  'Most Favored Nation': (doc, parties) =>
    `What most-favored-nation pricing does the ${doc} between ${parties} guarantee?`,
  'Liquidated Damages': (doc, parties) =>
    `What liquidated damages are payable under the ${doc} between ${parties}?`,
  'Source Code Escrow': (doc, parties) =>
    `Under what conditions is source code released from escrow under the ${doc} between ${parties}?`,
  'Covenant Not To Sue': (doc, parties) =>
    `What covenant not to sue does the ${doc} between ${parties} contain?`,
  'Non-Disparagement': (doc, parties) =>
    `What non-disparagement obligations does the ${doc} between ${parties} impose?`,
};

const SMALL_WORDS = new Set([
  'and',
  'of',
  'the',
  'for',
  'to',
  'in',
  'on',
  'a',
  'an',
  'or',
]);

/** CUAD writes document names in capitals: "DISTRIBUTOR AGREEMENT" → "Distributor Agreement". */
export function documentLabel(name: string): string {
  // Some normalised names keep the start of a defined term: `AGREEMENT ("`.
  const cleaned = name.replace(/[(“"].*$/s, '').replace(/[\s,;:.-]+$/, '');
  const words = cleaned.replace(/\s+/g, ' ').trim().toLowerCase().split(' ');
  return words
    .map((word, i) =>
      i > 0 && SMALL_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export function partiesLabel(parties: readonly string[]): string {
  return parties.length >= 2
    ? `${parties[0]} and ${parties[1]}`
    : (parties[0] ?? 'its parties');
}
