import { describe, expect, it } from 'vitest';
import { chunkNote, MAX_CHARS } from '../src/chunk.js';
import { Bm25Index, fuseRankings, rankByScore, tokenize } from '../src/bm25.js';
import { embedTextFor } from '../src/embed.js';
import { externalRank, isExpected, metrics, rankOf } from '../src/eval.js';

const c = (file: string, body: string) => ({ file, body });

describe('metrics', () => {
  it('computes recall at 5, recall at 10 and mean reciprocal rank on a worked example', () => {
    // ranks: 1, 3, 7, 12, not found  -> 5 scenes
    const m = metrics([1, 3, 7, 12, null]);
    expect(m.n).toBe(5);
    expect(m.recall5).toBeCloseTo(2 / 5); // ranks 1 and 3
    expect(m.recall10).toBeCloseTo(3 / 5); // plus rank 7
    expect(m.mrr).toBeCloseTo((1 + 1 / 3 + 1 / 7 + 1 / 12 + 0) / 5);
    expect(m.notFound).toBe(1);
  });

  it('handles an empty list without dividing by zero', () => {
    expect(metrics([])).toMatchObject({ n: 0, recall5: 0, recall10: 0, mrr: 0, notFound: 0 });
  });
});

describe('isExpected and rankOf', () => {
  const ranked = [
    c('a.md', 'The harbor master takes bribes.'),
    c('b.md', 'A **bold** [[Silver Key]] opens the *vault* door.'),
    c('c.md', 'The harbor master takes bribes.'),
  ];

  it('matches a snippet by "contains", ignoring case and spacing', () => {
    expect(rankOf(ranked, { scene: 's', expect: 'HARBOR   master' })).toBe(1);
  });

  it('accepts any one of several snippets', () => {
    expect(rankOf(ranked, { scene: 's', expect: ['no such text', 'vault door'] })).toBe(2);
  });

  it('strips markdown before matching', () => {
    expect(isExpected(ranked[1], { scene: 's', expect: 'bold silver key opens the vault' })).toBe(true);
  });

  it('narrows by file, tolerating backslashes and capitals', () => {
    expect(rankOf(ranked, { scene: 's', file: 'c.md', expect: 'harbor master' })).toBe(3);
    expect(rankOf(ranked, { scene: 's', file: 'C.MD', expect: 'harbor master' })).toBe(3);
  });

  it('returns null when nothing matches', () => {
    expect(rankOf(ranked, { scene: 's', expect: 'dragon' })).toBeNull();
    expect(rankOf(ranked, { scene: 's', file: 'zzz.md', expect: 'harbor master' })).toBeNull();
  });
});

describe('externalRank', () => {
  const results = ['Some unrelated note', 'the Harbor Master takes bribes in the evening', 'Tavern Ideas'];

  it('finds a snippet inside result text', () => {
    expect(externalRank(results, { scene: 's', expect: 'harbor master takes bribes' })).toBe(2);
  });

  it('matches a bare note name against the scene file', () => {
    expect(externalRank(results, { scene: 's', file: 'places/Tavern Ideas.md', expect: 'nothing like this' })).toBe(3);
  });

  it('returns null when not present', () => {
    expect(externalRank(results, { scene: 's', expect: 'dragon' })).toBeNull();
  });
});

describe('Bm25Index', () => {
  const docs = [
    'the tavern has a lantern and a lantern',
    'the tavern keeper hides an obsidian dagger',
    'the road is long and the road is dusty',
  ];
  const idx = new Bm25Index(docs);

  it('gives a rare word more weight than a common one', () => {
    const rare = idx.scores('obsidian');
    const common = idx.scores('tavern');
    expect(rare[1]).toBeGreaterThan(common[1]);
  });

  it('scores zero when no word is shared', () => {
    expect(idx.scores('dragon wizard')).toEqual([0, 0, 0]);
    expect(idx.scores('lantern')[2]).toBe(0);
  });

  it('ranks the matching idea first and skips zero scores', () => {
    expect(rankByScore(idx.scores('obsidian dagger'))).toEqual([1]);
  });

  it('drops stop words and single letters', () => {
    expect(tokenize('The a of Dagger x')).toEqual(['dagger']);
  });
});

describe('fuseRankings', () => {
  it('rewards ideas that rank well in both lists', () => {
    // idea 1 is second in both lists (2/62); ideas 0 and 2 are first in only one (1/61 each)
    expect(fuseRankings([[0, 1], [2, 1]])[0]).toBe(1);
  });

  it('includes ideas seen in only one list', () => {
    expect(fuseRankings([[0], [1]]).sort()).toEqual([0, 1]);
  });

  it('computes 1/(60+rank) points by hand', () => {
    // idea 5: rank1 in A (1/61) + rank2 in B (1/62); idea 7: rank1 in B (1/61) only
    expect(fuseRankings([[5, 9], [7, 5]])).toEqual([5, 7, 9]);
  });
});

describe('chunkNote with a configurable size', () => {
  const sentence = 'The old mill grinds grain for the village every single morning. ';
  const note = `# Mill\n\n${sentence.repeat(10)}\n`;

  it('keeps the default of 900 characters unchanged', () => {
    expect(MAX_CHARS).toBe(900);
    const a = chunkNote('mill.md', note);
    const b = chunkNote('mill.md', note, { maxChars: MAX_CHARS });
    expect(b.chunks.map((x) => x.body)).toEqual(a.chunks.map((x) => x.body));
  });

  it('gives more and shorter chunks with a small size', () => {
    const big = chunkNote('mill.md', note);
    const small = chunkNote('mill.md', note, { maxChars: 200 });
    expect(small.chunks.length).toBeGreaterThan(big.chunks.length);
    const longest = (n: typeof big) => Math.max(...n.chunks.map((x) => x.body.length));
    expect(longest(small)).toBeLessThan(longest(big));
  });
});

describe('embedTextFor', () => {
  const chunk = { context: 'Mill › Setting', body: 'Grinds grain.' };
  it('adds heading context by default', () => {
    expect(embedTextFor(chunk)).toBe('Mill › Setting: Grinds grain.');
  });
  it('uses only the body when heading context is off', () => {
    expect(embedTextFor(chunk, { headingContext: false })).toBe('Grinds grain.');
  });
});
