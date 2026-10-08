// A title is separated from the number by whitespace or a dash/colon — never
// glued to it, otherwise "Section 6.1, neither…" backtracks into number "6."
// plus title "1, neither…".
const TITLE = String.raw`(?:(?:\s+|\s*[-–—:]\s*)(?<title>[\p{Lu}\d][^.]{0,78}\.?))?`;
const NUMBER = String.raw`(?:\d+[a-z]?(?:\.\d+)*|[IVXLCDM]+)`;
const KEYWORD_BCS = String.raw`(?:[Čč]lan(?:ak)?|ČLAN(?:AK)?|[Čč]l\.|ČL\.)`;
const KEYWORD_EN = String.raw`(?:[Aa]rticle|ARTICLE|[Ss]ection|SECTION|[Cc]lause|CLAUSE)`;

export const HEADING_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`^\s*${KEYWORD_BCS}\s*\d+[a-z]?\.?${TITLE}\s*$`, 'u'),
  new RegExp(String.raw`^\s*${KEYWORD_EN}\s+${NUMBER}\.?${TITLE}\s*$`, 'u'),
  new RegExp(String.raw`^\s*§\s*\d+(?:\.\d+)*\.?${TITLE}\s*$`, 'u'),
  /^\s*\d+(?:\.\d+)*\.?\s+(?<title>[A-Z][A-Z0-9 ,&/()'-]{2,78})\s*$/u,
];

export const HEADING_MAX_LENGTH = 120;
export const SECTION_TITLE_MAX_LENGTH = 200;

export interface Section {
  /** The heading line, or null for text before the first heading. */
  title: string | null;
  /** Offsets into the source text; `start` includes the heading line itself. */
  start: number;
  end: number;
}

export function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > HEADING_MAX_LENGTH) {
    return false;
  }
  return HEADING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Sections are contiguous and cover the whole text, so a chunk built from any
 * section is always an exact substring of the source.
 */
export function detectSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: null, start: 0, end: text.length };
  let offset = 0;

  for (const line of text.split('\n')) {
    if (isHeadingLine(line)) {
      if (offset > current.start) {
        sections.push({ ...current, end: offset });
      }
      current = {
        title: line.trim().slice(0, SECTION_TITLE_MAX_LENGTH),
        start: offset,
        end: text.length,
      };
    }
    offset += line.length + 1; // the '\n' that split consumed
  }

  if (current.start < text.length || sections.length === 0) {
    sections.push(current);
  }
  return sections;
}
