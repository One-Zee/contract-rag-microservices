/**
 * What the model is told to say when the excerpts do not answer the question,
 * and what the service itself says when it declines before ever calling the
 * model. One sentence for both paths, so "stopa uzdržavanja" (§9.3) counts one
 * thing rather than two spellings of it.
 */
export const ABSTENTION_SENTENCE =
  'I do not have that information in the provided documents.';

/**
 * Whether the model's reply is the abstention sentence. Rule 3 asks for
 * exactly that sentence, but a model tends to go on after it — a remark about
 * something beside the question, with a citation — and the citation check
 * alone would then count the reply as an answer. Only the opening counts: a
 * reply that answers one part of a question and declines another is still an
 * answer. Quotes around it are allowed, since rule 3 shows the sentence in
 * quotes, and so is a missing full stop. Only the English sentence is
 * recognised: rule 5 lets a question in another language be declined in it.
 */
export function declinesInWords(reply: string): boolean {
  return reply
    .trimStart()
    .replace(/^["'\u201c\u2018]+/, '')
    .startsWith(ABSTENTION_SENTENCE.replace(/\.$/, ''));
}

/**
 * The system prompt — "uloga pravnog asistenta, obavezno citiranje,
 * zabrana izmišljanja".
 *
 * A constant rather than a template, because the rules it states are the ones
 * §9.3 measures. "Utemeljenost" and "tačnost citata" only mean something if
 * every answer in the evaluation set was produced under the same instructions,
 * so editing this text invalidates a measurement the way changing
 * `HNSW_EF_SEARCH` does.
 *
 * Note what it does *not* do: it asks the model to cite, and the service
 * checks afterwards whether the citations were real. An instruction is not a
 * guardrail — `citations.ts` is.
 */
export const SYSTEM_PROMPT = [
  'You are a contract analysis assistant. You answer questions about the',
  'contracts a user has access to, using only the numbered excerpts given to',
  'you in the CONTEXT block.',
  '',
  'Rules:',
  '1. Use only the CONTEXT. Do not use general knowledge about contracts, law,',
  '   or the parties involved, and never infer a term that is not written.',
  '2. Cite every factual claim with the bracketed number of the excerpt it came',
  '   from, like [1] or [3]. Place the citation immediately after the claim.',
  '   Only cite numbers that appear in the CONTEXT.',
  '3. If the CONTEXT does not contain the answer, reply exactly:',
  `   "${ABSTENTION_SENTENCE}"`,
  '   Do not guess, do not approximate, and do not offer a general answer.',
  '4. Quote the contract wording when the exact phrasing matters. Keep the',
  '   answer short; this is a reference tool, not a summary.',
  '5. Answer in the language of the question.',
].join('\n');
