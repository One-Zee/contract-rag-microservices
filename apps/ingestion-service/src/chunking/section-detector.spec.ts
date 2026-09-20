import { detectSections, isHeadingLine } from './section-detector.js';

describe('isHeadingLine', () => {
  it.each([
    'Član 5',
    'Član 5.',
    'Članak 12. Predmet ugovora',
    'ČLAN 7 - RASKID UGOVORA',
    'Čl. 3',
    'Article 3',
    'ARTICLE IV',
    'ARTICLE 1 - DEFINITIONS',
    'Section 4.2 Termination',
    'Section 4.2 Termination.',
    'Clause 7',
    'CLAUSE 12: Confidentiality',
    '§ 12',
    '§ 4.1 Scope',
    '1. DEFINITIONS',
    '2.1 SCOPE OF SERVICES',
    '  Article 3  ',
  ])('recognises %j', (line) => {
    expect(isHeadingLine(line)).toBe(true);
  });

  it.each([
    // a sentence that merely starts with a clause reference
    'Article 3 of this Agreement shall apply to every Statement of Work.',
    'Section 6.1, neither Party shall be liable for indirect loss.',
    // heading keyword followed by a sentence boundary and more prose
    'Section 2.1 Scope. The Provider shall perform the Services in accordance',
    // the keyword inside a sentence
    'as further described in Article 3 below',
    // numbered prose is not a capitalised heading
    '1.1 "Services" means the hosting, monitoring and support services',
    '3.2 If the Customer fails to pay any undisputed amount when due',
    // list items and bare numbers
    '1.',
    '(a) the Customer;',
    // too long to be a heading, whatever it starts with
    `Article 3 ${'Definitions '.repeat(12)}`,
    '',
    '   ',
  ])('rejects %j', (line) => {
    expect(isHeadingLine(line)).toBe(false);
  });
});

describe('detectSections', () => {
  const text = [
    'MASTER SERVICES AGREEMENT',
    'This Agreement is made between the Parties.',
    'ARTICLE 1 - DEFINITIONS',
    '1.1 "Services" means the hosting.',
    '1.2 "Fees" means the amounts payable.',
    'ARTICLE 2 - SERVICES',
    'Section 2.1 Scope',
    'The Provider shall perform the Services.',
  ].join('\n');

  it('starts a section at every heading and keeps the heading inside it', () => {
    const sections = detectSections(text);

    expect(sections.map((s) => s.title)).toEqual([
      null,
      'ARTICLE 1 - DEFINITIONS',
      'ARTICLE 2 - SERVICES',
      'Section 2.1 Scope',
    ]);
    expect(text.slice(sections[1].start, sections[1].end)).toBe(
      'ARTICLE 1 - DEFINITIONS\n1.1 "Services" means the hosting.\n1.2 "Fees" means the amounts payable.\n',
    );
  });

  it('covers the whole text contiguously, so chunks stay exact substrings', () => {
    const sections = detectSections(text);

    expect(sections[0].start).toBe(0);
    expect(sections.at(-1)!.end).toBe(text.length);
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].start).toBe(sections[i - 1].end);
    }
  });

  it('returns one untitled section for text without headings', () => {
    expect(detectSections('just prose\nand more prose')).toEqual([
      { title: null, start: 0, end: 25 },
    ]);
  });

  it('does not emit an empty preamble when the text opens with a heading', () => {
    const sections = detectSections('ARTICLE 1\nbody');

    expect(sections).toEqual([{ title: 'ARTICLE 1', start: 0, end: 14 }]);
  });

  it('caps the stored title length', () => {
    const title = `Section 1 ${'A'.repeat(70)}`;
    const [section] = detectSections(`${title}\nbody`);

    expect(section.title!.length).toBeLessThanOrEqual(200);
    expect(section.title).toBe(title);
  });
});
