import { fuse, type RankedId } from './rrf.js';

const ranked = (...ids: string[]): RankedId[] =>
  ids.map((id, index) => ({ id, rank: index + 1 }));

const K = 60;

describe('reciprocal rank fusion', () => {
  it('scores a single list as 1/(k + rank) and keeps its order', () => {
    const fused = fuse([ranked('a', 'b', 'c')], K);

    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / 61, 10);
    expect(fused[1].score).toBeCloseTo(1 / 62, 10);
    expect(fused.map((f) => f.ranks)).toEqual([[1], [2], [3]]);
  });

  // The reason the search runs twice: agreement between branches outweighs a
  // single branch's confidence.
  it('puts a chunk both branches found above one only the first ranked first', () => {
    const fused = fuse([ranked('a', 'b'), ranked('c', 'b')], K);

    expect(fused[0].id).toBe('b');
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 62, 10);
    expect(fused[0].ranks).toEqual([2, 2]);
  });

  it('records the rank per branch and null where a branch missed it', () => {
    const fused = fuse([ranked('a'), ranked('b', 'a')], K);
    const byId = new Map(fused.map((f) => [f.id, f]));

    expect(byId.get('a')!.ranks).toEqual([1, 2]);
    expect(byId.get('b')!.ranks).toEqual([null, 1]);
  });

  it('is unchanged by an empty list, and empty for no input at all', () => {
    expect(fuse([ranked('a', 'b'), []], K).map((f) => f.id)).toEqual([
      'a',
      'b',
    ]);
    expect(fuse([[], []], K)).toEqual([]);
    expect(fuse([], K)).toEqual([]);
  });

  // Small k weights the top positions heavily, large k flattens them — the
  // parameter the measurements in phase 7 hold constant.
  it('lets k decide between one first place and two mediocre ones', () => {
    const lists = [ranked('first'), ranked('x', 'y', 'z', 'shared')];
    const withShared = [
      ...lists,
      [{ id: 'shared', rank: 4 }] satisfies RankedId[],
    ];

    expect(fuse(withShared, 1)[0].id).toBe('first');
    expect(fuse(withShared, 1000)[0].id).toBe('shared');
  });

  it('breaks ties by first appearance, not by id', () => {
    const fused = fuse([ranked('z', 'a'), ranked('z', 'a')], K);

    expect(fused.map((f) => f.id)).toEqual(['z', 'a']);
    expect(fuse([ranked('b'), ranked('a')], K).map((f) => f.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('counts every distinct id exactly once', () => {
    const fused = fuse([ranked('a', 'b', 'c'), ranked('c', 'b', 'd')], K);

    expect(fused).toHaveLength(4);
    expect(new Set(fused.map((f) => f.id)).size).toBe(4);
  });
});
