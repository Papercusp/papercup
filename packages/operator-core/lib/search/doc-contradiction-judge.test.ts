import { describe, it, expect, vi } from 'vitest';

import {
  judgeContradictions,
  judgeInconclusive,
  describeContradictionReport,
  buildContradictionPrompt,
  type JudgeCandidate,
  type JudgeSection,
  type ContradictionCensus,
} from './doc-contradiction-judge';

const candidate = (a: string, b: string, similarity: number): JudgeCandidate => ({
  a,
  b,
  similarity,
  kind: 'cross-kind',
});

const section = (id: string, content = `content of ${id}`): JudgeSection => ({
  id,
  title: `Title ${id}`,
  content,
});

/** Loader that satisfies every id it is asked for. */
const loaderFor = (ids: readonly string[]) =>
  vi.fn(async () => new Map(ids.map((id) => [id, section(id)])));

const baseOpts = {
  judgeThreshold: 0.95,
  maxJudged: 10,
  enabled: true,
  judgeAvailable: true,
};

describe('judgeContradictions — required configuration', () => {
  it('throws on a missing judgeThreshold: it sets both the cost and the recall of the LLM leg', async () => {
    await expect(
      judgeContradictions({
        ...baseOpts,
        judgeThreshold: undefined as unknown as number,
        candidates: [],
        loadSections: loaderFor([]),
        judge: vi.fn(),
      }),
    ).rejects.toThrow(/judgeThreshold/);
  });

  it('throws on a non-positive maxJudged', async () => {
    await expect(
      judgeContradictions({
        ...baseOpts,
        maxJudged: 0,
        candidates: [],
        loadSections: loaderFor([]),
        judge: vi.fn(),
      }),
    ).rejects.toThrow(/maxJudged/);
  });
});

describe('judgeContradictions — an empty result is never silently clean', () => {
  it('a DISABLED flag is inconclusive, and the judge is never called', async () => {
    const judge = vi.fn();
    const report = await judgeContradictions({
      ...baseOpts,
      enabled: false,
      candidates: [candidate('a', 'b', 0.99)],
      loadSections: loaderFor(['a', 'b']),
      judge,
    });
    expect(report.contradictions).toEqual([]);
    expect(report.inconclusive).toMatch(/DISABLED/);
    expect(judge).not.toHaveBeenCalled();
    // The eligible population is still reported, so "disabled" carries its own
    // denominator rather than looking like an empty corpus.
    expect(report.census.eligible).toBe(1);
  });

  it('an UNAVAILABLE judge is inconclusive, and no content is loaded', async () => {
    // This is the bug this module is built around: `createAnthropicJudge()`
    // returns a silent no-op with no key, whose `{conflicts: []}` is
    // byte-identical to a healthy "nothing contradicts" (EI-18746586784230719,
    // EI-18747066020546067). The availability probe is checked BEFORE any
    // content is loaded, so a caller never pays to feed an inert judge.
    const loadSections = loaderFor(['a', 'b']);
    const judge = vi.fn();
    const report = await judgeContradictions({
      ...baseOpts,
      judgeAvailable: false,
      candidates: [candidate('a', 'b', 0.99)],
      loadSections,
      judge,
    });
    expect(report.inconclusive).toMatch(/no contradiction judge could be built/);
    expect(loadSections).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });

  it('CONTROL: an inert judge is DISTINGUISHABLE from a clean corpus', async () => {
    // The falsifiability control for this whole module. Both runs return
    // `contradictions: []`; the ONLY thing that separates them is
    // `inconclusive`. If this test ever passes trivially, the contract has been
    // lost and the module has regressed to the bug it was written to avoid.
    const inert = await judgeContradictions({
      ...baseOpts,
      judgeAvailable: false,
      candidates: [candidate('a', 'b', 0.99)],
      loadSections: loaderFor(['a', 'b']),
      judge: vi.fn(),
    });
    const clean = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.99)],
      loadSections: loaderFor(['a', 'b']),
      judge: vi.fn(async () => ({ contradicts: false, reason: '' })),
    });

    expect(inert.contradictions).toEqual([]);
    expect(clean.contradictions).toEqual([]);
    expect(inert.inconclusive).not.toBeNull();
    expect(clean.inconclusive).toBeNull();
    expect(describeContradictionReport(inert)).toMatch(/NOT evidence/);
    expect(describeContradictionReport(clean)).not.toMatch(/INCONCLUSIVE/);
  });

  it('no eligible pair is inconclusive, and says which of the two zeroes it is', async () => {
    const noCandidates = await judgeContradictions({
      ...baseOpts,
      candidates: [],
      loadSections: loaderFor([]),
      judge: vi.fn(),
    });
    expect(noCandidates.inconclusive).toMatch(/supplied no candidate pairs/);

    const allBelow = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.9)],
      loadSections: loaderFor(['a', 'b']),
      judge: vi.fn(),
    });
    expect(allBelow.inconclusive).toMatch(/reached the judge threshold/);
    expect(allBelow.census.candidatesIn).toBe(1);
    expect(allBelow.census.eligible).toBe(0);
  });
});

describe('judgeContradictions — judging', () => {
  it('finds a contradiction and reports it conclusively', async () => {
    const judge = vi.fn(async () => ({ contradicts: true, reason: 'A says always, B says never' }));
    const report = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.97)],
      loadSections: loaderFor(['a', 'b']),
      judge,
    });
    expect(report.inconclusive).toBeNull();
    expect(report.contradictions).toHaveLength(1);
    expect(report.contradictions[0].reason).toBe('A says always, B says never');
    expect(report.contradictions[0].similarity).toBe(0.97);
    expect(report.census.judged).toBe(1);
    expect(report.census.contradictionsFound).toBe(1);
  });

  it('only pairs at or above the threshold are asked — cheap by construction', async () => {
    const judge = vi.fn(async () => ({ contradicts: false, reason: '' }));
    const report = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.99), candidate('c', 'd', 0.5), candidate('e', 'f', 0.95)],
      loadSections: loaderFor(['a', 'b', 'e', 'f']),
      judge,
    });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(report.census.candidatesIn).toBe(3);
    expect(report.census.eligible).toBe(2);
  });

  it('the cap asks the HIGHEST-similarity pairs and counts the rest as unasked', async () => {
    const judge = vi.fn(async () => ({ contradicts: false, reason: '' }));
    const report = await judgeContradictions({
      ...baseOpts,
      maxJudged: 1,
      candidates: [candidate('lo', 'lo2', 0.96), candidate('hi', 'hi2', 0.99)],
      loadSections: loaderFor(['hi', 'hi2']),
      judge,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0].a.id).toBe('hi');
    expect(report.census.unjudgedOverCap).toBe(1);
    // A capped run still answered what it asked, so it is not inconclusive —
    // the census is what makes the partiality visible.
    expect(report.inconclusive).toBeNull();
  });

  it('a THROWING judge is an error, never a "no contradiction"', async () => {
    const judge = vi.fn(async () => {
      throw new Error('gateway 429');
    });
    const report = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.99)],
      loadSections: loaderFor(['a', 'b']),
      judge,
    });
    expect(report.census.judgeErrors).toBe(1);
    expect(report.census.contradictionsFound).toBe(0);
    // Every judged pair errored, so the empty result measured nothing.
    expect(report.inconclusive).toMatch(/judge failure/);
  });

  it('a NULL verdict is an error, never a "no contradiction"', async () => {
    const report = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.99)],
      loadSections: loaderFor(['a', 'b']),
      judge: vi.fn(async () => null),
    });
    expect(report.census.judgeErrors).toBe(1);
    expect(report.inconclusive).toMatch(/judge failure/);
  });

  it('SOME errors still leave the run conclusive for what it did answer', async () => {
    let call = 0;
    const judge = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('transient');
      return { contradicts: false, reason: '' };
    });
    const report = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.99), candidate('c', 'd', 0.98)],
      loadSections: loaderFor(['a', 'b', 'c', 'd']),
      judge,
    });
    expect(report.census.judgeErrors).toBe(1);
    expect(report.inconclusive).toBeNull();
  });

  it('a pair whose content is missing is COUNTED, not silently skipped', async () => {
    const judge = vi.fn(async () => ({ contradicts: false, reason: '' }));
    const report = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'missing', 0.99)],
      loadSections: vi.fn(async () => new Map([['a', section('a')]])),
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(report.census.contentMissing).toBe(1);
    expect(report.census.judged).toBe(0);
    expect(report.inconclusive).toMatch(/no pair reached the judge/);
  });
});

describe('judgeInconclusive', () => {
  const census = (over: Partial<ContradictionCensus> = {}): ContradictionCensus => ({
    candidatesIn: 5,
    eligible: 5,
    judged: 5,
    unjudgedOverCap: 0,
    contentMissing: 0,
    judgeErrors: 0,
    contradictionsFound: 0,
    ...over,
  });

  it('is null when the judge actually answered at least one pair', () => {
    expect(judgeInconclusive(census())).toBeNull();
    expect(judgeInconclusive(census({ judgeErrors: 4 }))).toBeNull();
  });

  it('flags a run where nothing was judged, or nothing answered', () => {
    expect(judgeInconclusive(census({ judged: 0 }))).toMatch(/measured nothing/);
    expect(judgeInconclusive(census({ judgeErrors: 5 }))).toMatch(/judge failure/);
  });
});

describe('describeContradictionReport', () => {
  it('cannot be quoted without its denominator', async () => {
    const report = await judgeContradictions({
      ...baseOpts,
      candidates: [candidate('a', 'b', 0.99), candidate('c', 'd', 0.4)],
      loadSections: loaderFor(['a', 'b']),
      judge: vi.fn(async () => ({ contradicts: false, reason: '' })),
    });
    const text = describeContradictionReport(report);
    expect(text).toContain('1 judged pair');
    expect(text).toContain('1 eligible of 2 candidates');
    expect(text).toContain('0.95');
  });
});

describe('buildContradictionPrompt', () => {
  it('asks the ONE narrow question and rules redundancy out explicitly', () => {
    const prompt = buildContradictionPrompt(section('a', 'always retry'), section('b', 'never retry'));
    expect(prompt).toMatch(/ONE QUESTION/);
    expect(prompt).toMatch(/OPPOSITE actions in the same situation/);
    // Without this, the judge reports every kind-1 sibling-boilerplate pair as a
    // finding, which is the high-volume bucket — the report would drown.
    expect(prompt).toMatch(/Redundancy is NOT a contradiction/);
    expect(prompt).toContain('always retry');
    expect(prompt).toContain('never retry');
  });
});
