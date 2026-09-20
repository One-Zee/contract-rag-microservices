import { assembleDocumentText } from './document-text.js';

describe('assembleDocumentText', () => {
  it('joins normalised pages and records where each one lies', () => {
    const { text, pages } = assembleDocumentText({
      pages: [
        { number: 1, text: 'First page.  \r\n' },
        { number: 2, text: '\n\nSecond page.' },
      ],
      text: 'ignored for paginated input',
    });

    expect(text).toBe('First page.\nSecond page.');
    expect(pages).toEqual([
      { number: 1, start: 0, end: 11 },
      { number: 2, start: 12, end: 24 },
    ]);
    for (const page of pages) {
      expect(text.slice(page.start, page.end)).not.toMatch(/^\n|\n$/);
    }
  });

  it('skips blank pages without renumbering the rest', () => {
    const { text, pages } = assembleDocumentText({
      pages: [
        { number: 1, text: 'Cover' },
        { number: 2, text: '  \n\n ' },
        { number: 3, text: 'Body' },
      ],
      text: '',
    });

    expect(text).toBe('Cover\nBody');
    expect(pages.map((p) => p.number)).toEqual([1, 3]);
  });

  it('normalises page-less text and reports no spans', () => {
    const { text, pages } = assembleDocumentText({
      pages: null,
      text: 'Paragraph one.\r\n\r\n\r\n\r\nParagraph two.',
    });

    expect(text).toBe('Paragraph one.\n\nParagraph two.');
    expect(pages).toEqual([]);
  });

  it('yields empty text for a document whose pages are all blank', () => {
    expect(
      assembleDocumentText({ pages: [{ number: 1, text: '\n\n' }], text: '' }),
    ).toEqual({ text: '', pages: [] });
  });
});
