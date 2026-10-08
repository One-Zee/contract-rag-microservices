import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { type ChunkDraft, chunkText, type PageSpan } from './chunker.js';

const sentence = (n: number) =>
  `Sentence number ${n} states an obligation of the Provider under clause ${n}.`;

const paragraph = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => sentence(from + i)).join(' ');

/** `paragraphs` paragraphs of `perParagraph` sentences each, blank-line separated. */
const prose = (paragraphs: number, perParagraph = 4) =>
  Array.from({ length: paragraphs }, (_, p) =>
    paragraph(p * perParagraph + 1, perParagraph),
  ).join('\n\n');

const expectSequentialIndices = (chunks: ChunkDraft[]) =>
  expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));

describe('chunkText', () => {
  it('keeps every chunk within the token budget and numbers them in order', () => {
    const source = prose(12);
    const chunks = chunkText(source, { chunkSize: 60, chunkOverlap: 10 });

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(60);
      expect(chunk.tokenCount).toBe(countTokens(chunk.content));
    }
    expectSequentialIndices(chunks);
  });

  it('produces exact substrings of the source, so nothing is rewritten', () => {
    const source = prose(6);
    const chunks = chunkText(source, { chunkSize: 60, chunkOverlap: 10 });

    for (const chunk of chunks) {
      expect(source).toContain(chunk.content);
    }
  });

  it('covers the whole text — every sentence lands in at least one chunk', () => {
    const source = prose(10);
    const chunks = chunkText(source, { chunkSize: 60, chunkOverlap: 10 });
    const joined = chunks.map((c) => c.content).join('\n');

    for (let n = 1; n <= 40; n++) {
      expect(joined).toContain(sentence(n));
    }
  });

  it('starts each chunk with the tail of the previous one when overlap is requested', () => {
    const source = prose(10);
    const chunks = chunkText(source, { chunkSize: 60, chunkOverlap: 20 });

    for (let i = 1; i < chunks.length; i++) {
      const firstSentence = chunks[i].content.split('. ')[0];
      expect(chunks[i - 1].content).toContain(firstSentence);
    }
  });

  it('shares nothing between chunks when overlap is zero', () => {
    const source = prose(10);
    const chunks = chunkText(source, { chunkSize: 60, chunkOverlap: 0 });

    for (let i = 1; i < chunks.length; i++) {
      const firstSentence = chunks[i].content.split('. ')[0];
      expect(chunks[i - 1].content).not.toContain(firstSentence);
    }
  });

  it('never lets a chunk cross a section boundary and labels it with the heading', () => {
    const source = [
      'ARTICLE 1 - DEFINITIONS',
      paragraph(1, 2),
      'ARTICLE 2 - SERVICES',
      paragraph(3, 2),
      'ARTICLE 3 - FEES',
      paragraph(5, 2),
    ].join('\n');
    const chunks = chunkText(source, { chunkSize: 200, chunkOverlap: 20 });

    expect(chunks.map((c) => c.sectionTitle)).toEqual([
      'ARTICLE 1 - DEFINITIONS',
      'ARTICLE 2 - SERVICES',
      'ARTICLE 3 - FEES',
    ]);
    for (const chunk of chunks) {
      const headings = chunk.content.match(/ARTICLE \d/g) ?? [];
      expect(headings).toHaveLength(1);
    }
  });

  it('merges the same short sections into fewer chunks when sections are ignored', () => {
    const source = [
      'ARTICLE 1 - DEFINITIONS',
      paragraph(1, 2),
      'ARTICLE 2 - SERVICES',
      paragraph(3, 2),
      'ARTICLE 3 - FEES',
      paragraph(5, 2),
    ].join('\n');

    const aware = chunkText(source, { chunkSize: 200, chunkOverlap: 20 });
    const naive = chunkText(source, {
      chunkSize: 200,
      chunkOverlap: 20,
      respectSections: false,
    });

    expect(aware).toHaveLength(3);
    expect(naive).toHaveLength(1);
    expect(naive[0].sectionTitle).toBeNull();
  });

  it('gives text before the first heading no section title', () => {
    const source = `Preamble text.\nARTICLE 1\n${paragraph(1, 1)}`;
    const chunks = chunkText(source, { chunkSize: 100, chunkOverlap: 0 });

    expect(chunks[0].sectionTitle).toBeNull();
    expect(chunks[1].sectionTitle).toBe('ARTICLE 1');
  });

  it('splits a paragraph without line breaks at sentence boundaries', () => {
    const source = paragraph(1, 20);
    const chunks = chunkText(source, { chunkSize: 50, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(50);
      expect(chunk.content.endsWith('.')).toBe(true);
    }
  });

  it('falls back to words when a sentence alone exceeds the budget', () => {
    const source = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(source, { chunkSize: 40, chunkOverlap: 5 });

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(40);
      expect(chunk.content).not.toMatch(/^\s|\s$/);
    }
  });

  it('cuts a string without any separator by characters as a last resort', () => {
    const source = 'x'.repeat(4000);
    const chunks = chunkText(source, { chunkSize: 60, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(60);
    }
    expect(chunks.map((c) => c.content).join('')).toBe(source);
  });

  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('', { chunkSize: 100, chunkOverlap: 10 })).toEqual([]);
    expect(chunkText(' \n\n ', { chunkSize: 100, chunkOverlap: 10 })).toEqual(
      [],
    );
  });

  it('keeps a short text as a single chunk', () => {
    const chunks = chunkText('One short clause.', {
      chunkSize: 800,
      chunkOverlap: 120,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      index: 0,
      content: 'One short clause.',
      pageNumber: null,
      sectionTitle: null,
    });
  });

  it('assigns each chunk the page on which it starts', () => {
    const page1 = paragraph(1, 3);
    const page2 = paragraph(4, 3);
    const source = `${page1}\n${page2}`;
    const pages: PageSpan[] = [
      { number: 1, start: 0, end: page1.length },
      { number: 2, start: page1.length + 1, end: source.length },
    ];
    const chunks = chunkText(source, { chunkSize: 30, chunkOverlap: 0, pages });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].pageNumber).toBe(1);
    expect(chunks.at(-1)!.pageNumber).toBe(2);
    for (const chunk of chunks) {
      const start = source.indexOf(chunk.content);
      const expected = pages.find((p) => start >= p.start && start < p.end)!;
      expect(chunk.pageNumber).toBe(expected.number);
    }
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    expect(() =>
      chunkText('text', { chunkSize: 100, chunkOverlap: 100 }),
    ).toThrow(RangeError);
    expect(() => chunkText('text', { chunkSize: 0, chunkOverlap: 0 })).toThrow(
      RangeError,
    );
  });
});
