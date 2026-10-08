// Generates the three test fixtures from contract-text.mjs:
//   contract-sample.pdf   (two pages, headings + paragraphs, Helvetica)
//   contract-sample.docx  (same text, Heading1 paragraphs)
//   blank.pdf             (one page, no text at all)
import { writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { blocks } from './contract-text.mjs';

const OUT = process.argv[2] ?? '.';

// ---------- PDF ----------
const PAGE = { w: 595.28, h: 841.89 }; // A4
const MARGIN = 56;
const FONT_SIZE = 10;
const LINE = 12.4;
const MAX_WIDTH = PAGE.w - 2 * MARGIN;

function wrap(text, font, size) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= MAX_WIDTH) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function makeContractPdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Master Services Agreement (sample fixture)');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - MARGIN;
  };

  for (const block of blocks) {
    const isHeading = block.kind !== 'para';
    const font = isHeading ? bold : regular;
    const size = block.kind === 'title' ? 13 : FONT_SIZE;
    const lines = wrap(block.text, font, size);
    const needed = lines.length * LINE + LINE; // block + blank line after it
    if (y - needed < MARGIN) newPage();
    if (isHeading) y -= LINE * 0.4;
    for (const line of lines) {
      page.drawText(line, { x: MARGIN, y, size, font });
      y -= LINE;
    }
    y -= LINE * 0.8;
  }

  const bytes = await pdf.save();
  writeFileSync(`${OUT}/contract-sample.pdf`, bytes);
  return pdf.getPageCount();
}

async function makeBlankPdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([PAGE.w, PAGE.h]);
  writeFileSync(`${OUT}/blank.pdf`, await pdf.save());
}

// ---------- DOCX ----------
async function makeContractDocx() {
  const children = blocks.map((block) => {
    if (block.kind === 'title') {
      return new Paragraph({ text: block.text, heading: HeadingLevel.TITLE });
    }
    if (block.kind === 'heading') {
      return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 });
    }
    return new Paragraph({ text: block.text });
  });
  const doc = new Document({ sections: [{ children }] });
  writeFileSync(`${OUT}/contract-sample.docx`, await Packer.toBuffer(doc));
}

const pages = await makeContractPdf();
await makeBlankPdf();
await makeContractDocx();
console.log(`contract-sample.pdf: ${pages} page(s)`);
