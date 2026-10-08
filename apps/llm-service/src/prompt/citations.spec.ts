import { extractMarkers, validateCitations } from './citations.js';

describe('extractMarkers', () => {
  it('finds each distinct marker once, in first-appearance order', () => {
    expect(
      extractMarkers(
        'Ninety days [3]. Renewal is automatic [1], see also [3].',
      ),
    ).toEqual([3, 1]);
  });

  it('reads a two-digit marker as one number', () => {
    expect(extractMarkers('as stated [12]')).toEqual([12]);
    expect(extractMarkers('as stated [1][2]')).toEqual([1, 2]);
  });

  it('ignores brackets that are not citations', () => {
    expect(extractMarkers('see [a], [see 3], [] and [ 4 ]')).toEqual([]);
  });

  it('returns nothing for an answer that cites nothing', () => {
    expect(extractMarkers('I believe the answer is ninety days.')).toEqual([]);
  });
});

describe('validateCitations', () => {
  it('accepts markers that name an excerpt really in the prompt', () => {
    expect(validateCitations([1, 3], 5)).toEqual({
      valid: [1, 3],
      invalid: [],
    });
  });

  // The whole point of the guardrail: an answer that looks sourced and is not.
  it('rejects a marker beyond the context that was sent', () => {
    expect(validateCitations([1, 9], 4)).toEqual({ valid: [1], invalid: [9] });
  });

  it('rejects zero — the block is numbered from one', () => {
    expect(validateCitations([0, 1], 3)).toEqual({ valid: [1], invalid: [0] });
  });

  it('rejects everything when no context was sent at all', () => {
    expect(validateCitations([1], 0)).toEqual({ valid: [], invalid: [1] });
  });

  it('handles an answer with no markers', () => {
    expect(validateCitations([], 5)).toEqual({ valid: [], invalid: [] });
  });
});
