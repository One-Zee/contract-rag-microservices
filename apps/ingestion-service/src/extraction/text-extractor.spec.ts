import { readFileSync } from 'node:fs';
import { assembleDocumentText } from '../chunking/document-text.js';
import { chunkText } from '../chunking/chunker.js';
import {
  DocxTextExtractor,
  PdfTextExtractor,
  sniffMimeType,
  TextExtractionService,
} from './text-extractor.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../test/fixtures/${name}`, import.meta.url));

const PDF = 'application/pdf';
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('PdfTextExtractor', () => {
  it('returns the text of every page, in order, without page markers', async () => {
    const result = await new PdfTextExtractor().extract(
      fixture('contract-sample.pdf'),
    );

    expect(result.pages).toHaveLength(3);
    expect(result.pages!.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(result.pages![0].text).toContain('MASTER SERVICES AGREEMENT');
    expect(result.pages![2].text).toContain('IN WITNESS WHEREOF');
    expect(result.text).not.toMatch(/-- \d+ of \d+ --/);
  });

  it('returns only whitespace for a page without a text layer', async () => {
    const result = await new PdfTextExtractor().extract(fixture('blank.pdf'));

    expect(result.pages).toHaveLength(1);
    expect(result.text.trim()).toBe('');
  });

  it('rejects bytes that only pretend to be a PDF', async () => {
    const fake = Buffer.from('%PDF-1.7 this is not a pdf at all');

    await expect(new PdfTextExtractor().extract(fake)).rejects.toThrow();
  });
});

describe('DocxTextExtractor', () => {
  it('returns paragraphs separated by blank lines and no pages', async () => {
    const result = await new DocxTextExtractor().extract(
      fixture('contract-sample.docx'),
    );

    expect(result.pages).toBeNull();
    expect(result.text).toContain('\n\nARTICLE 1 - DEFINITIONS\n\n');
    expect(result.text).toContain('IN WITNESS WHEREOF');
  });

  it('rejects a zip that is not a Word document', async () => {
    // A valid, empty zip archive: "PK\5\6" end-of-central-directory record.
    const emptyZip = Buffer.from(
      '504b0506000000000000000000000000000000000000',
      'hex',
    );

    await expect(new DocxTextExtractor().extract(emptyZip)).rejects.toThrow();
  });
});

describe('sniffMimeType', () => {
  it('recognises the fixtures by their signature', () => {
    expect(sniffMimeType(fixture('contract-sample.pdf'))).toBe(PDF);
    expect(sniffMimeType(fixture('contract-sample.docx'))).toBe(DOCX);
  });

  it('returns null for text that merely claims to be a document', () => {
    expect(sniffMimeType(Buffer.from('hello, world'))).toBeNull();
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
    expect(sniffMimeType(Buffer.from('%PD'))).toBeNull();
  });
});

describe('TextExtractionService', () => {
  it('dispatches on the MIME type', async () => {
    const service = new TextExtractionService();

    const pdf = await service.extract(fixture('contract-sample.pdf'), PDF);
    const docx = await service.extract(fixture('contract-sample.docx'), DOCX);

    expect(pdf.pages).toHaveLength(3);
    expect(docx.pages).toBeNull();
  });

  it('refuses a MIME type it has no extractor for', () => {
    expect(() =>
      new TextExtractionService().extract(Buffer.from('x'), 'text/plain'),
    ).toThrow('text/plain');
  });
});

/**
 * The whole extraction → chunking path over the real fixture, with the
 * production defaults — the numbers here are what the e2e relies on.
 */
describe('fixture end to end', () => {
  it('chunks the sample contract into page- and section-labelled pieces', async () => {
    const extracted = await new PdfTextExtractor().extract(
      fixture('contract-sample.pdf'),
    );
    const { text, pages } = assembleDocumentText(extracted);
    const chunks = chunkText(text, {
      chunkSize: 800,
      chunkOverlap: 120,
      pages,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].pageNumber).toBe(1);
    expect(chunks.at(-1)!.pageNumber).toBe(3);
    expect(chunks.map((c) => c.sectionTitle)).toContain('ARTICLE 2 - SERVICES');
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(800);
      expect(text).toContain(chunk.content);
    }
  });
});
