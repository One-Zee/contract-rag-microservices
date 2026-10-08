/**
 * Text as both sides can agree on it. CUAD annotated its own text extraction
 * and the system extracts with pdf-parse, so the same clause differs in line
 * breaks, hyphenation, quote characters and stray page furniture. Matching
 * therefore works on lowercased word tokens, never on character offsets.
 */
export function tokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―]/g, '-')
    .split(/[^a-z0-9$%]+/)
    .filter((token) => token.length > 0);
}

/**
 * Length of the longest run of consecutive tokens `needle` and `haystack`
 * share — the longest common substring over words. O(n·m) with one row of
 * memory; a span is tens of words and a chunk a few hundred.
 */
export function longestCommonRun(
  needle: readonly string[],
  haystack: readonly string[],
): number {
  let best = 0;
  let previous = new Uint16Array(haystack.length + 1);
  let current = new Uint16Array(haystack.length + 1);
  for (let i = 1; i <= needle.length; i++) {
    for (let j = 1; j <= haystack.length; j++) {
      if (needle[i - 1] === haystack[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) {
          best = current[j];
        }
      } else {
        current[j] = 0;
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return best;
}
