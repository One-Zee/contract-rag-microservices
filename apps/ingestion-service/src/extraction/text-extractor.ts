import { Injectable } from '@nestjs/common';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { type AcceptedMimeType, isAcceptedMimeType } from '@app/common';

export interface ExtractedPage {
  /** 1-based, as printed by a viewer. */
  number: number;
  text: string;
}

export interface ExtractedText {
  /** Per-page text for paginated formats; `null` when the format has no pages (DOCX). */
  pages: ExtractedPage[] | null;
  /** The whole text, raw — normalisation happens in the chunking step. */
  text: string;
}

export interface TextExtractor {
  extract(bytes: Buffer): Promise<ExtractedText>;
}

/**
 * pdf-parse v2 (pdf.js underneath). Text is taken per page so that chunks can
 * carry a page number; `pageJoiner: ''` keeps the library from stamping
 * "-- 1 of 3 --" markers into the text.
 */
export class PdfTextExtractor implements TextExtractor {
  async extract(bytes: Buffer): Promise<ExtractedText> {
    // A copy, not a view: pdf.js takes ownership of the array it is given, and
    // a small Node Buffer may be a slice of a shared pool.
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText({ pageJoiner: '' });
      const pages = result.pages.map((page) => ({
        number: page.num,
        text: page.text,
      }));
      return { pages, text: pages.map((page) => page.text).join('\n') };
    } finally {
      await parser.destroy();
    }
  }
}

/** DOCX has no fixed pagination — a page is whatever the printer decides. */
export class DocxTextExtractor implements TextExtractor {
  async extract(bytes: Buffer): Promise<ExtractedText> {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { pages: null, text: result.value };
  }
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\3\4" — DOCX is a zip

/**
 * What the bytes say they are, independent of the declared MIME type. A zip
 * signature is taken as DOCX; anything else inside it fails in mammoth later,
 * which is the right place for that failure.
 */
export function sniffMimeType(bytes: Buffer): AcceptedMimeType | null {
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return 'application/pdf';
  }
  if (bytes.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return null;
}

@Injectable()
export class TextExtractionService {
  private readonly extractors: Record<AcceptedMimeType, TextExtractor> = {
    'application/pdf': new PdfTextExtractor(),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      new DocxTextExtractor(),
  };

  extract(bytes: Buffer, mimeType: string): Promise<ExtractedText> {
    if (!isAcceptedMimeType(mimeType)) {
      throw new Error(`No text extractor for ${mimeType}`);
    }
    return this.extractors[mimeType].extract(bytes);
  }
}
