import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import type { SearchResultDto } from '@app/common';

export interface BuiltContext {
  /** The CONTEXT block, ready to go in the user turn. Empty when nothing fit. */
  block: string;
  /**
   * The chunks that made it in, in prompt order: `used[i]` is `[i + 1]`.
   * Shorter than the input when the budget ran out.
   */
  used: SearchResultDto[];
  /** What the block cost, by cl100k_base's reckoning. */
  tokens: number;
}

export interface BuildContextOptions {
  maxTokens: number;
}

/**
 * Renders retrieved chunks as the numbered CONTEXT block of plan §8.3:
 * "5 segmenata s oznakama [1], [2]… i metapodacima".
 *
 * The numbering runs over the chunks that are actually included — never over
 * `QUERY_CONTEXT_CHUNKS`. Retrieval caps what it returns at its own
 * `SEARCH_FUSED`, and the budget below can drop more, so a prompt that said
 * "[5]" when only three excerpts were present would be inviting exactly the
 * hallucinated citation that `citations.ts` then has to catch.
 *
 * The budget is spent from the top: results arrive ranked, so what gets
 * dropped is what the reranker liked least. Chunks are never truncated — half
 * a clause is worse than no clause, because the model cannot tell it is half.
 *
 * `countTokens` is cl100k_base, which is neither Claude's tokenizer nor
 * Llama's (ADR 009 records the same caveat for chunking). It is an
 * approximation on purpose: the authoritative count comes back from the
 * provider afterwards and is what `answers.tokens_in` stores.
 */
export const buildContext = (
  results: SearchResultDto[],
  options: BuildContextOptions,
): BuiltContext => {
  const used: SearchResultDto[] = [];
  const rendered: string[] = [];
  let tokens = 0;

  for (const result of results) {
    const entry = renderEntry(result, used.length + 1);
    const cost = countTokens(entry);
    if (used.length > 0 && tokens + cost > options.maxTokens) {
      break;
    }
    // The first excerpt goes in even if it busts the budget on its own: an
    // answer grounded in one oversized clause beats abstaining because the
    // clause was long.
    used.push(result);
    rendered.push(entry);
    tokens += cost;
  }

  return { block: rendered.join('\n\n'), used, tokens };
};

/** `[n]` plus the metadata a citation needs to be checkable by a human. */
const renderEntry = (result: SearchResultDto, marker: number): string => {
  const parts = [result.documentTitle];
  if (result.pageNumber !== null) {
    parts.push(`page ${result.pageNumber}`);
  }
  if (result.sectionTitle !== null && result.sectionTitle.length > 0) {
    parts.push(result.sectionTitle);
  }
  return `[${marker}] ${parts.join(' · ')}\n${result.content}`;
};

/**
 * The user turn: the excerpts, then the question. The question goes last so it
 * is the most recent thing in the context window, which is where instruction
 * following is most reliable.
 */
export const buildPrompt = (block: string, question: string): string =>
  `CONTEXT:\n${block}\n\nQUESTION:\n${question}`;
