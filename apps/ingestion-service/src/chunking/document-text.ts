import type { ExtractedText } from '../extraction/text-extractor.js';
import type { PageSpan } from './chunker.js';
import { normalizeText } from './text-normalizer.js';

export interface DocumentText {
  /** Normalised text of the whole document — what chunks are substrings of. */
  text: string;
  /** Where each page lies in `text`; empty for formats without pages. */
  pages: PageSpan[];
}

/** Pages are joined with a line break, not a blank line: a paragraph that runs across a page boundary is still one paragraph. */
const PAGE_JOINER = '\n';

/**
 * Normalises page by page and joins, recording the offsets — page numbers of
 * chunks are looked up against these spans, so nothing after this step may
 * change the text again. Pages that are blank after normalisation are dropped
 * from the spans but keep the numbering of the original document.
 */
export function assembleDocumentText(extracted: ExtractedText): DocumentText {
  if (extracted.pages === null) {
    return { text: normalizeText(extracted.text), pages: [] };
  }

  const parts: string[] = [];
  const pages: PageSpan[] = [];
  let offset = 0;
  for (const page of extracted.pages) {
    const text = normalizeText(page.text);
    if (text.length === 0) {
      continue;
    }
    if (parts.length > 0) {
      offset += PAGE_JOINER.length;
    }
    parts.push(text);
    pages.push({
      number: page.number,
      start: offset,
      end: offset + text.length,
    });
    offset += text.length;
  }
  return { text: parts.join(PAGE_JOINER), pages };
}
