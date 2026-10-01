import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import type { SearchResultDto } from '@app/common';
import { buildContext, buildPrompt } from './context-block.js';

const result = (overrides: Partial<SearchResultDto> = {}): SearchResultDto => ({
  chunkId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222',
  documentTitle: 'Acme MSA',
  chunkIndex: 0,
  content: 'Either party may terminate this Agreement upon ninety days notice.',
  pageNumber: 4,
  sectionTitle: 'Termination',
  score: 0.9,
  vectorRank: 1,
  lexicalRank: 1,
  similarity: 0.82,
  ...overrides,
});

describe('buildContext', () => {
  it('numbers the excerpts from one and carries their metadata', () => {
    const { block, used } = buildContext(
      [result(), result({ documentTitle: 'Beta NDA', pageNumber: 2 })],
      { maxTokens: 6000 },
    );

    expect(used).toHaveLength(2);
    expect(block).toContain('[1] Acme MSA · page 4 · Termination');
    expect(block).toContain('[2] Beta NDA · page 2 · Termination');
    expect(block).toContain(
      'Either party may terminate this Agreement upon ninety days notice.',
    );
  });

  it('omits metadata that is absent rather than printing null', () => {
    const { block } = buildContext(
      [result({ pageNumber: null, sectionTitle: null })],
      { maxTokens: 6000 },
    );

    expect(block).toContain('[1] Acme MSA\n');
    expect(block).not.toContain('null');
    expect(block).not.toContain('page');
  });

  it('treats an empty section title as absent', () => {
    const { block } = buildContext([result({ sectionTitle: '' })], {
      maxTokens: 6000,
    });

    expect(block).toContain('[1] Acme MSA · page 4\n');
  });

  // The markers must match what is really in the prompt: numbering over the
  // requested count would invite exactly the invented citation that
  // `validateCitations` then has to reject.
  it('numbers over the excerpts that fit, not the ones it was offered', () => {
    const long = result({ content: 'clause text. '.repeat(200) });
    const { block, used } = buildContext([long, long, long], {
      maxTokens: countTokens(long.content) + 40,
    });

    expect(used).toHaveLength(1);
    expect(block).toContain('[1]');
    expect(block).not.toContain('[2]');
  });

  it('drops from the bottom, keeping the best-ranked excerpts', () => {
    const first = result({ content: 'first '.repeat(100) });
    const second = result({ content: 'second '.repeat(100) });
    const third = result({ content: 'third '.repeat(100) });

    const { used } = buildContext([first, second, third], {
      maxTokens: countTokens(first.content) * 2 + 60,
    });

    expect(used.map((u) => u.content)).toEqual([first.content, second.content]);
  });

  // Half a clause is worse than no clause: the model cannot tell it is half.
  it('keeps a single oversized excerpt rather than returning nothing', () => {
    const huge = result({ content: 'clause '.repeat(5000) });

    const { used, block } = buildContext([huge], { maxTokens: 10 });

    expect(used).toHaveLength(1);
    expect(block).toContain(huge.content);
  });

  it('returns an empty block for no results', () => {
    const { block, used, tokens } = buildContext([], { maxTokens: 6000 });

    expect(block).toBe('');
    expect(used).toEqual([]);
    expect(tokens).toBe(0);
  });
});

describe('buildPrompt', () => {
  it('puts the question after the context', () => {
    const prompt = buildPrompt('[1] Acme MSA\nclause', 'How much notice?');

    expect(prompt.indexOf('CONTEXT:')).toBeLessThan(
      prompt.indexOf('QUESTION:'),
    );
    expect(prompt).toContain('How much notice?');
    expect(prompt.trimEnd().endsWith('How much notice?')).toBe(true);
  });
});
