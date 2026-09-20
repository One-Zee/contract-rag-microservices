import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { detectSections, type Section } from './section-detector.js';

/**
 * Token-budgeted, clause-aware segmentation (plan §8.1, ADR 009).
 *
 * The text is first cut into sections at clause headings; each section is
 * then split recursively — paragraphs, lines, sentences, words, and as a last
 * resort characters — until every piece fits the budget, and the pieces are
 * packed back into windows of at most `chunkSize` tokens. Consecutive windows
 * share up to `chunkOverlap` tokens so that a fact straddling a boundary is
 * whole in at least one of them. Windows never cross a section boundary.
 *
 * Everything works on offsets into the source text, so a chunk is always an
 * exact substring of it and can be mapped back to a page.
 *
 * Tokens are counted with the `cl100k_base` encoding. The embedding model has
 * its own tokenizer, so the budget is approximate by design; what is exact is
 * `tokenCount`, recomputed on the finished chunk.
 */

export const SEPARATORS: readonly string[] = ['\n\n', '\n', '. ', ' '];

export interface PageSpan {
  number: number;
  /** Offsets into the source text, `end` exclusive. */
  start: number;
  end: number;
}

export interface ChunkingOptions {
  chunkSize: number;
  chunkOverlap: number;
  /** `false` ignores headings — the naive baseline for the phase-7 comparison. */
  respectSections?: boolean;
  /** Page boundaries of the source text; empty for formats without pages. */
  pages?: readonly PageSpan[];
}

export interface ChunkDraft {
  index: number;
  content: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  tokenCount: number;
}

interface Piece {
  start: number;
  end: number;
  tokens: number;
}

interface Window {
  start: number;
  end: number;
}

export function chunkText(
  source: string,
  {
    chunkSize,
    chunkOverlap,
    respectSections = true,
    pages = [],
  }: ChunkingOptions,
): ChunkDraft[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(
      `chunkSize must be a positive integer, got ${chunkSize}`,
    );
  }
  if (
    !Number.isInteger(chunkOverlap) ||
    chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  ) {
    throw new RangeError(
      `chunkOverlap must be an integer in [0, chunkSize), got ${chunkOverlap}`,
    );
  }

  const sections: Section[] = respectSections
    ? detectSections(source)
    : [{ title: null, start: 0, end: source.length }];

  // Pieces are cut to leave room for the overlap: a piece that fits next to a
  // full overlap is what lets consecutive windows actually share text. Windows
  // themselves still fill up to `chunkSize`.
  const pieceBudget = chunkSize - chunkOverlap;

  const drafts: ChunkDraft[] = [];
  for (const section of sections) {
    const pieces = splitRange(
      source,
      section.start,
      section.end,
      0,
      pieceBudget,
    );
    for (const window of packWindows(source, pieces, chunkSize, chunkOverlap)) {
      const content = source.slice(window.start, window.end).trim();
      if (content.length === 0) {
        continue;
      }
      const contentStart = window.start + leadingWhitespace(source, window);
      drafts.push({
        index: drafts.length,
        content,
        pageNumber: pageAt(pages, contentStart),
        sectionTitle: section.title,
        tokenCount: countTokens(content),
      });
    }
  }
  return drafts;
}

/** Cuts [start, end) at the separator of the given level until every piece fits. */
function splitRange(
  source: string,
  start: number,
  end: number,
  level: number,
  budget: number,
): Piece[] {
  const tokens = countTokens(source.slice(start, end));
  if (tokens <= budget) {
    return [{ start, end, tokens }];
  }
  if (level >= SEPARATORS.length) {
    return hardSplit(source, start, end, budget);
  }
  const parts = splitBy(source, start, end, SEPARATORS[level]);
  if (parts.length === 1) {
    return splitRange(source, start, end, level + 1, budget);
  }
  return parts.flatMap(([partStart, partEnd]) =>
    splitRange(source, partStart, partEnd, level + 1, budget),
  );
}

/**
 * Contiguous ranges covering [start, end); each separator stays attached to
 * the piece before it, so no character of the source is ever lost.
 */
function splitBy(
  source: string,
  start: number,
  end: number,
  separator: string,
): [number, number][] {
  const parts: [number, number][] = [];
  let position = start;
  for (;;) {
    const found = source.indexOf(separator, position);
    if (found === -1 || found + separator.length > end) {
      break;
    }
    parts.push([position, found + separator.length]);
    position = found + separator.length;
    if (position >= end) {
      break;
    }
  }
  if (position < end) {
    parts.push([position, end]);
  }
  return parts;
}

/** No separator left to use (e.g. a very long token): halve until it fits. */
function hardSplit(
  source: string,
  start: number,
  end: number,
  budget: number,
): Piece[] {
  const tokens = countTokens(source.slice(start, end));
  if (tokens <= budget || end - start <= 1) {
    return [{ start, end, tokens }];
  }
  let middle = start + Math.floor((end - start) / 2);
  // Never cut a surrogate pair in half.
  const code = source.charCodeAt(middle);
  if (code >= 0xdc00 && code <= 0xdfff && middle > start + 1) {
    middle -= 1;
  }
  return [
    ...hardSplit(source, start, middle, budget),
    ...hardSplit(source, middle, end, budget),
  ];
}

/** Greedy packing; the tail of each window is carried into the next one. */
function packWindows(
  source: string,
  pieces: readonly Piece[],
  chunkSize: number,
  chunkOverlap: number,
): Window[] {
  const windows: Window[] = [];
  let current: Piece[] = [];
  let currentTokens = 0;

  for (const piece of pieces) {
    if (current.length > 0 && currentTokens + piece.tokens > chunkSize) {
      const window = { start: current[0].start, end: current.at(-1)!.end };
      windows.push(window);
      const overlap = overlapTail(source, window, chunkOverlap);
      if (overlap && overlap.tokens + piece.tokens <= chunkSize) {
        current = [overlap];
        currentTokens = overlap.tokens;
      } else {
        current = [];
        currentTokens = 0;
      }
    }
    current.push(piece);
    currentTokens += piece.tokens;
  }

  if (current.length > 0) {
    windows.push({ start: current[0].start, end: current.at(-1)!.end });
  }
  return windows;
}

/**
 * The longest suffix of the window within the overlap budget, cut at the
 * coarsest boundary that yields one — paragraph, line, sentence, word. The
 * pieces the window was packed from are not reused here on purpose: a window
 * made of two 300-token paragraphs would otherwise get no overlap at all,
 * because neither paragraph fits in 120 tokens.
 */
function overlapTail(
  source: string,
  window: Window,
  chunkOverlap: number,
): Piece | null {
  if (chunkOverlap === 0) {
    return null;
  }
  for (const separator of SEPARATORS) {
    let best: Piece | null = null;
    let position = source.lastIndexOf(separator, window.end - separator.length);
    // Walk boundaries from the end; the suffix grows until it no longer fits.
    while (position > window.start) {
      const start = position + separator.length;
      if (start < window.end) {
        const tokens = countTokens(source.slice(start, window.end));
        if (tokens > chunkOverlap) {
          break;
        }
        best = { start, end: window.end, tokens };
      }
      position = source.lastIndexOf(separator, position - 1);
    }
    if (best) {
      return best;
    }
  }
  return null;
}

function leadingWhitespace(source: string, window: Window): number {
  let offset = window.start;
  while (offset < window.end && /\s/.test(source[offset])) {
    offset += 1;
  }
  return offset - window.start;
}

function pageAt(pages: readonly PageSpan[], offset: number): number | null {
  const page = pages.find((p) => offset >= p.start && offset < p.end);
  return page ? page.number : null;
}
