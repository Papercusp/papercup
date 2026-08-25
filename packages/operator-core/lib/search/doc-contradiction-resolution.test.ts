/**
 * P-005: the autonomous-resolution three-way seam.
 *
 * The load-bearing control here is the REFUSE/FILE side-by-side: the same
 * inputs with an inconclusive report file NOTHING and with a conclusive report
 * file — no constant implementation satisfies both, so the gate cannot pass
 * trivially (D-011's falsifiability shape).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContradictionCensus, ContradictionReport } from './doc-contradiction-judge';
import type { KindedFinding } from './doc-contradiction-scan';
import {
  authorshipOfDocSource,
  contradictionDedupeKey,
  describeResolutionReport,
  fixShapeFor,
  resolveContradictions,
  type ContradictionWorkItemFiler,
  type ContradictionWorkItemSpec,
} from './doc-contradiction-resolution';

function census(overrides: Partial<ContradictionCensus> = {}): ContradictionCensus {
  return {
    candidatesIn: 2,
    eligible: 2,
    judged: 2,
    unjudgedOverCap: 0,
    contentMissing: 0,
    judgeErrors: 0,
    contradictionsFound: 1,
    ...overrides,
  };
}

function kindedFinding(overrides: Partial<KindedFinding> = {}): KindedFinding {
  const a = overrides.a ?? 'papercusp-guidance::tool-guidance/alpha::sec';
  const b = overrides.b ?? 'papercusp-guidance::tool-guidance/beta::sec';
  return {
    a,
    b,
    similarity: 0.95,
    refA: { sourceKey: 'papercusp-guidance', slug: 'tool-guidance/alpha', anchor: 'sec' },
    refB: { sourceKey: 'papercusp-guidance', slug: 'tool-guidance/beta', anchor: 'sec' },
    sameSource: true,
    appliedThreshold: 0.92,
    kind: 'sibling-surface',
    basis: 'same-surface',
    surfaceA: 'tool-guidance',
    surfaceB: 'tool-guidance',
    confident: false,
    ...overrides,
  } as KindedFinding;
}

function reportWith(
  kinded: readonly KindedFinding[],
  inconclusive: string | null = null,
): ContradictionReport {
  return {
    judgeThreshold: 0.94,
    contradictions: kinded.map((k) => ({
      a: k.a,
      b: k.b,
      similarity: k.similarity,
      kind: k.kind,
      reason: 'A says always X; B says never X',
    })),
    census: census({ contradictionsFound: kinded.length }),
    inconclusive,
  };
}

function mockFiler(overrides: Partial<ContradictionWorkItemFiler> = {}): {
  filer: ContradictionWorkItemFiler;
  findExisting: ReturnType<typeof vi.fn>;
  file: ReturnType<typeof vi.fn>;
} {
  const findExisting = vi.fn(async () => null as { id: string } | null);
  const file = vi.fn(async (_spec: ContradictionWorkItemSpec) => ({ id: 'WI-90001' }));
  return {
    filer: { findExisting, file, ...overrides },
    findExisting,
    file,
  };
}

describe('contradictionDedupeKey', () => {
  it('is order-independent', () => {
    expect(contradictionDedupeKey('x', 'y')).toBe(contradictionDedupeKey('y', 'x'));
    expect(contradictionDedupeKey('x', 'y')).toBe('doc-contradiction::x::y');
  });
});

describe('authorshipOfDocSource', () => {
  it('classifies the pinned corpus roots as authored and everything else as unknown', () => {
    expect(authorshipOfDocSource('papercusp-guidance')).toBe('authored');
    expect(authorshipOfDocSource('papercusp-engineering')).toBe('authored');
    expect(authorshipOfDocSource('learned-shadow-corpus')).toBeNull();
    expect(authorshipOfDocSource('')).toBeNull();
  });
});

describe('resolveContradictions — the inconclusive gate (the falsifiability control)', () => {
  it('REFUSES an inconclusive report (nothing filed, filer never consulted) AND files from the same input when conclusive', async () => {
    const kinded = [kindedFinding()];

    // Side A: inconclusive — the current live state (no judge credential).
    const inert = mockFiler();
    const refusedRun = await resolveContradictions({
      kinded,
      report: reportWith(kinded, 'no contradiction judge could be built'),
      filer: inert.filer,
    });
    expect(refusedRun.refused).toContain('INCONCLUSIVE');
    expect(refusedRun.refused).toContain('no contradiction judge could be built');
    expect(refusedRun.census.filed).toBe(0);
    expect(refusedRun.dispositions).toHaveLength(0);
    expect(inert.findExisting).not.toHaveBeenCalled();
    expect(inert.file).not.toHaveBeenCalled();
    // The population is still visible against the refusal.
    expect(refusedRun.census.contradictionsIn).toBe(1);

    // Side B: the SAME input, conclusive — must file. A constant implementation
    // cannot satisfy both sides.
    const live = mockFiler();
    const filedRun = await resolveContradictions({
      kinded,
      report: reportWith(kinded, null),
      filer: live.filer,
    });
    expect(filedRun.refused).toBeNull();
    expect(filedRun.census.filed).toBe(1);
    expect(live.file).toHaveBeenCalledTimes(1);
  });
});

describe('resolveContradictions — the three-way seam', () => {
  it('files authored-vs-authored with the structured finding on the spec', async () => {
    const kinded = [kindedFinding()];
    const { filer, file } = mockFiler();
    const run = await resolveContradictions({ kinded, report: reportWith(kinded), filer });

    expect(run.census.filed).toBe(1);
    expect(run.dispositions[0]).toMatchObject({
      disposition: 'filed',
      seam: 'authored-authored',
      workItemId: 'WI-90001',
    });
    const spec = file.mock.calls[0][0] as ContradictionWorkItemSpec;
    expect(spec.dedupeKey).toBe(contradictionDedupeKey(kinded[0].a, kinded[0].b));
    expect(spec.title).toContain('Guidance contradiction');
    expect(spec.body).toContain('A says always X; B says never X');
    expect(spec.body).toContain('0.9500');
    expect(spec.finding).toMatchObject({ kind: 'sibling-surface', confident: false });
  });

  it('routes the learned legs INERT — counted, never filed', async () => {
    const authoredLearned = kindedFinding({
      a: 'papercusp-guidance::tool-guidance/alpha::sec',
      b: 'learned-corpus::insights/beta::sec',
      refB: { sourceKey: 'learned-corpus', slug: 'insights/beta', anchor: 'sec' },
    });
    const learnedLearned = kindedFinding({
      a: 'learned-corpus::insights/gamma::sec',
      b: 'learned-corpus::insights/delta::sec',
      refA: { sourceKey: 'learned-corpus', slug: 'insights/gamma', anchor: 'sec' },
      refB: { sourceKey: 'learned-corpus', slug: 'insights/delta', anchor: 'sec' },
    });
    const kinded = [authoredLearned, learnedLearned];
    const { filer, file } = mockFiler();
    const run = await resolveContradictions({
      kinded,
      report: reportWith(kinded),
      filer,
      authorshipOf: (key) => (key === 'learned-corpus' ? 'learned' : 'authored'),
    });

    expect(run.census.inertLearnedLeg).toBe(2);
    expect(run.census.filed).toBe(0);
    expect(file).not.toHaveBeenCalled();
    expect(run.dispositions.map((d) => d.seam)).toEqual(['authored-learned', 'learned-learned']);
    for (const d of run.dispositions) {
      expect(d.disposition).toBe('inert-learned-leg');
      expect(d.note).toContain('workstream B');
    }
  });

  it('never files an unrecognised source key — counted as unknown authorship', async () => {
    const kinded = [
      kindedFinding({
        b: 'mystery-source::doc/x::sec',
        refB: { sourceKey: 'mystery-source', slug: 'doc/x', anchor: 'sec' },
      }),
    ];
    const { filer, file } = mockFiler();
    const run = await resolveContradictions({ kinded, report: reportWith(kinded), filer });

    expect(run.census.unknownAuthorship).toBe(1);
    expect(run.census.filed).toBe(0);
    expect(file).not.toHaveBeenCalled();
    expect(run.dispositions[0].disposition).toBe('unknown-authorship');
    expect(run.dispositions[0].note).toContain('mystery-source');
  });

  it('counts a contradiction missing from the kinded findings as unknown, never guesses', async () => {
    const kinded = [kindedFinding()];
    const report = reportWith(kinded);
    const { filer, file } = mockFiler();
    // Pass an EMPTY kinded set: the join misses.
    const run = await resolveContradictions({ kinded: [], report, filer });

    expect(run.census.unknownAuthorship).toBe(1);
    expect(file).not.toHaveBeenCalled();
    expect(run.dispositions[0].note).toContain('missing from the kinded findings');
  });
});

describe('resolveContradictions — dedupe', () => {
  it('suppresses a pair a non-terminal work item already tracks', async () => {
    const kinded = [kindedFinding()];
    const { filer, file, findExisting } = mockFiler();
    findExisting.mockResolvedValueOnce({ id: 'WI-77777' });
    const run = await resolveContradictions({ kinded, report: reportWith(kinded), filer });

    expect(run.census.duplicates).toBe(1);
    expect(run.census.filed).toBe(0);
    expect(file).not.toHaveBeenCalled();
    expect(run.dispositions[0]).toMatchObject({ disposition: 'duplicate', workItemId: 'WI-77777' });
  });

  it('dedupes the reversed pair to the same key', async () => {
    const forward = kindedFinding();
    const reversed = kindedFinding({
      a: forward.b,
      b: forward.a,
      refA: forward.refB,
      refB: forward.refA,
    });
    const { filer, findExisting } = mockFiler();
    await resolveContradictions({ kinded: [forward], report: reportWith([forward]), filer });
    await resolveContradictions({ kinded: [reversed], report: reportWith([reversed]), filer });

    expect(findExisting.mock.calls[0][0]).toBe(findExisting.mock.calls[1][0]);
  });
});

describe('resolveContradictions — filing errors and the census partition', () => {
  it('counts a filing error and continues with the remaining findings', async () => {
    const first = kindedFinding();
    const second = kindedFinding({
      a: 'papercusp-engineering::doc/one::s',
      b: 'papercusp-engineering::doc/two::s',
      refA: { sourceKey: 'papercusp-engineering', slug: 'doc/one', anchor: 's' },
      refB: { sourceKey: 'papercusp-engineering', slug: 'doc/two', anchor: 's' },
    });
    const kinded = [first, second];
    const { filer, file } = mockFiler();
    file.mockRejectedValueOnce(new Error('pg down'));
    const run = await resolveContradictions({ kinded, report: reportWith(kinded), filer });

    expect(run.census.fileErrors).toBe(1);
    expect(run.census.filed).toBe(1);
    expect(run.dispositions[0]).toMatchObject({ disposition: 'file-error' });
    expect(run.dispositions[0].note).toContain('pg down');
    expect(run.dispositions[1]).toMatchObject({ disposition: 'filed' });
  });

  it('partitions every contradiction into exactly one bucket', async () => {
    const filedOne = kindedFinding();
    const dupOne = kindedFinding({
      a: 'papercusp-guidance::tool-guidance/dup1::s',
      b: 'papercusp-guidance::tool-guidance/dup2::s',
      refA: { sourceKey: 'papercusp-guidance', slug: 'tool-guidance/dup1', anchor: 's' },
      refB: { sourceKey: 'papercusp-guidance', slug: 'tool-guidance/dup2', anchor: 's' },
    });
    const learnedOne = kindedFinding({
      a: 'learned-x::doc/a::s',
      b: 'learned-x::doc/b::s',
      refA: { sourceKey: 'learned-x', slug: 'doc/a', anchor: 's' },
      refB: { sourceKey: 'learned-x', slug: 'doc/b', anchor: 's' },
    });
    const unknownOne = kindedFinding({
      a: 'mystery::doc/a::s',
      b: 'mystery::doc/b::s',
      refA: { sourceKey: 'mystery', slug: 'doc/a', anchor: 's' },
      refB: { sourceKey: 'mystery', slug: 'doc/b', anchor: 's' },
    });
    const kinded = [filedOne, dupOne, learnedOne, unknownOne];
    const { filer, findExisting } = mockFiler();
    findExisting.mockImplementation(async (key: string) =>
      key.includes('dup1') ? { id: 'WI-1' } : null,
    );
    const run = await resolveContradictions({
      kinded,
      report: reportWith(kinded),
      filer,
      authorshipOf: (key) =>
        key === 'learned-x' ? 'learned' : key === 'mystery' ? null : 'authored',
    });

    const c = run.census;
    expect(c.contradictionsIn).toBe(4);
    expect(c.filed + c.duplicates + c.inertLearnedLeg + c.unknownAuthorship + c.fileErrors).toBe(
      c.contradictionsIn,
    );
    expect(run.dispositions).toHaveLength(4);
  });
});

describe('fixShapeFor — keyed on (kind, confident), not kind alone', () => {
  it('prescribes canonicalisation only for a CONFIDENT rehomed-copy', () => {
    expect(fixShapeFor('rehomed-copy', true)).toContain('canonical');
    expect(fixShapeFor('rehomed-copy', false)).not.toContain('make ONE home canonical');
    expect(fixShapeFor('rehomed-copy', false)).toContain('residual');
  });

  it('prescribes rewording the opposed clause for the other kinds', () => {
    expect(fixShapeFor('sibling-surface', false)).toContain('opposed clause');
    expect(fixShapeFor('cross-kind', false)).toContain('opposed clause');
  });
});

describe('describeResolutionReport', () => {
  it('quotes the population on a refusal and states that nothing was filed', async () => {
    const kinded = [kindedFinding()];
    const { filer } = mockFiler();
    const run = await resolveContradictions({
      kinded,
      report: reportWith(kinded, 'the contradiction leg is DISABLED'),
      filer,
    });
    const text = describeResolutionReport(run);
    expect(text).toContain('REFUSED');
    expect(text).toContain('1 contradiction(s)');
    expect(text).toContain('none was filed');
  });

  it('quotes every bucket against the denominator on a normal run', async () => {
    const kinded = [kindedFinding()];
    const { filer } = mockFiler();
    const run = await resolveContradictions({ kinded, report: reportWith(kinded), filer });
    const text = describeResolutionReport(run);
    expect(text).toContain('1 work item(s) filed from 1 contradiction(s)');
    expect(text).toContain('0 already tracked');
    expect(text).toContain('0 on inert learned legs');
    expect(text).toContain('0 unknown authorship');
  });
});
