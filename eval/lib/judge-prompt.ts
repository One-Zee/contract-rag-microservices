/**
 * The judge's instructions, versioned: a changed prompt is a changed
 * instrument, and every judgement file records which one produced it.
 */
export const JUDGE_PROMPT_VERSION = 'v2';

// v2 (2026-10-05): the first real run showed claude-sonnet-5 listing "the
// excerpts do not say X" as a claim despite being told to ignore it — an
// uncitable claim that counted against groundedness — and an answer that
// declined in words while citing excerpts for a side remark, which the
// system's own check counts as answered. So every claim now carries a kind,
// and the verdict says whether the answer declines.
export const JUDGE_SYSTEM = `You evaluate answers produced by a contract-analysis assistant.
The assistant answers a question from numbered contract excerpts and marks
every claim with the excerpt it relies on, like [1] or [2][3].

Do four things:

1. Split the answer into atomic claims — one statement each, pleasantries
   left out. Give every claim a kind: "fact" if it states something about
   the contracts, their parties or their terms; "meta" if it is about the
   excerpts or documents themselves — that some information is or is not
   in them, or which documents they come from.
2. For every claim, list the citation markers attached to it. For each marker,
   decide whether that excerpt, on its own, supports the claim: "yes" if the
   excerpt states it or directly implies it, "no" otherwise. A claim without a
   marker has an empty list.
3. Decide whether the answer declines: "yes" if its main message is that the
   requested information is not available in the excerpts, even when it adds
   cited side remarks; "no" if it gives an answer to the question.
4. Compare the whole answer with the reference: "yes" if it conveys the
   reference's substance, "partial" if it conveys part of it or adds a
   material error, "no" if it does not.

Judge only against the excerpts and the reference given. Do not use outside
knowledge of these contracts. Reply with JSON only, in this shape:

{"claims":[{"text":"…","kind":"fact","markers":[{"n":1,"supports":"yes"}]}],"declines":"no","correct":"yes","reason":"one sentence"}`;

export interface JudgeInput {
  question: string;
  answer: string;
  excerpts: { marker: number; text: string }[];
  reference: string;
}

export function judgeUserMessage(input: JudgeInput): string {
  const excerpts =
    input.excerpts.length === 0
      ? '(the answer cites nothing)'
      : input.excerpts.map((e) => `[${e.marker}] ${e.text}`).join('\n\n');
  return [
    `QUESTION:\n${input.question}`,
    `ANSWER:\n${input.answer}`,
    `CITED EXCERPTS:\n${excerpts}`,
    `REFERENCE:\n${input.reference}`,
  ].join('\n\n---\n\n');
}

export interface Judgement {
  claims: {
    text: string;
    kind: 'fact' | 'meta';
    markers: { n: number; supports: 'yes' | 'no' }[];
  }[];
  declines: 'yes' | 'no';
  correct: 'yes' | 'partial' | 'no';
  reason: string;
}

/** The model is asked for JSON only; this still tolerates a fence or a preamble. */
export function parseJudgement(text: string): Judgement {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`No JSON in judge reply: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as Judgement;
  if (
    !Array.isArray(parsed.claims) ||
    !parsed.claims.every((claim) => ['fact', 'meta'].includes(claim.kind)) ||
    !['yes', 'no'].includes(parsed.declines) ||
    !['yes', 'partial', 'no'].includes(parsed.correct)
  ) {
    throw new Error(`Judge reply has the wrong shape: ${text.slice(0, 200)}`);
  }
  return parsed;
}
