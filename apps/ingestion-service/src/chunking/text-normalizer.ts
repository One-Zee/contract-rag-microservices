/**
 * Puts extracted text into the one form the rest of the pipeline assumes.
 *
 * Applied per page, before pages are joined, so that page offsets computed
 * afterwards stay valid — nothing downstream may change the length of the
 * text again.
 */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replaceAll('\u0000', '')
    .replace(/[ \t\f\v]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
