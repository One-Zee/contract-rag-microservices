import { normalizeText } from './text-normalizer.js';

const NUL = String.fromCharCode(0);

describe('normalizeText', () => {
  it('strips NUL characters, which Postgres text columns reject', () => {
    const withNul = `Ar${NUL}ticle 1${NUL}`;

    expect(normalizeText(withNul)).toBe('Article 1');
    expect(normalizeText(withNul)).not.toContain(NUL);
  });

  it('turns Windows and old Mac line endings into \\n', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('collapses runs of blank lines to a single blank line', () => {
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('removes trailing whitespace per line and around the text', () => {
    expect(normalizeText('  a  \t\nb \f\n\n')).toBe('a\nb');
  });

  it('leaves clean text untouched', () => {
    const clean = 'ARTICLE 1\n\n1.1 Services means the hosting.\n\nARTICLE 2';

    expect(normalizeText(clean)).toBe(clean);
  });
});
