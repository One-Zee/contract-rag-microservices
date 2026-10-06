import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFParse } from 'pdf-parse';

export interface PdfStats {
  pages: number;
  chars: number;
  sha256: string;
}

/**
 * The same pdf-parse call the ingestion service makes, so "has a text layer"
 * means what it will mean when the system reads the file.
 */
export async function pdfStats(file: string): Promise<PdfStats> {
  const bytes = readFileSync(file);
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText({ pageJoiner: '' });
    const chars = result.pages.reduce(
      (sum, page) => sum + page.text.replace(/\s+/g, '').length,
      0,
    );
    return {
      pages: result.pages.length,
      chars,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await parser.destroy();
  }
}
