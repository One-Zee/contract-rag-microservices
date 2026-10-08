/**
 * Plan §8.4: "Provjera da citirani indeksi postoje u dostavljenom kontekstu".
 *
 * This is the guardrail the system prompt's "only cite numbers that appear in
 * the CONTEXT" is not: an instruction is a request, and a model that invents
 * `[9]` over a four-excerpt context has not broken any code path — it has
 * produced an answer that looks sourced and is not.
 *
 * The check happens after the answer has streamed, which is a deliberate
 * trade: suppressing a bad marker would mean buffering the whole answer before
 * sending any of it, and the point of streaming is that the user reads while
 * the model writes. So an invented marker is *reported* — excluded from
 * `answer_citations`, counted on `answers.citations_offered`, and named in the
 * `done` event — rather than removed from text the user has already seen.
 */

/**
 * Bracketed integers, at most three digits.
 *
 * `[12]` is twelve, not one-then-two: the regex takes the longest run of
 * digits inside one pair of brackets, so a context of twelve excerpts is
 * citable. Anything else in the brackets — `[see 3]`, `[a]`, `[]` — is not a
 * citation and is left alone.
 */
const MARKER = /\[(\d{1,3})\]/g;

/**
 * Every distinct marker the answer contains, in the order they first appear.
 *
 * First-appearance order matters: it is the order a reader meets the sources
 * in, so it is the order the citation list should be rendered in.
 */
export const extractMarkers = (text: string): number[] => {
  const seen = new Set<number>();
  const markers: number[] = [];

  for (const match of text.matchAll(MARKER)) {
    const marker = Number(match[1]);
    if (!seen.has(marker)) {
      seen.add(marker);
      markers.push(marker);
    }
  }

  return markers;
};

export interface CitationCheck {
  /** Markers that name an excerpt that was really in the prompt. */
  valid: number[];
  /** Markers that did not. Reported, never silently dropped. */
  invalid: number[];
}

/**
 * Splits the markers against the context that was actually sent.
 * `contextSize` is `used.length` from `buildContext`, never the configured
 * chunk count — those differ whenever retrieval returned less than it was
 * asked for.
 */
export const validateCitations = (
  markers: number[],
  contextSize: number,
): CitationCheck => {
  const valid: number[] = [];
  const invalid: number[] = [];

  for (const marker of markers) {
    // `[0]` is invalid too: the block is numbered from 1, so a zero is as
    // invented as a nine over four excerpts.
    if (marker >= 1 && marker <= contextSize) {
      valid.push(marker);
    } else {
      invalid.push(marker);
    }
  }

  return { valid, invalid };
};
