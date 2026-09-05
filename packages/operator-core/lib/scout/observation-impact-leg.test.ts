/**
 * Tests for the P-021 observation→impact readback leg
 * (su-ideate-learning-substrate-2026-07-10). Two halves:
 *   - the PURE core: patternRefToIssueId (wi: drill-back parse),
 *     flattenObservationCitablePatterns (the 3 friction-derived lanes only),
 *     computeObservationsImpact (the filings → citing-patterns → grounded-ideas →
 *     shipped funnel, with the via-ref scoping);
 *   - the IMPURE resolveObservationsImpact: the fail-open contract (kill switch /
 *     VITEST-inert / blank / dep errors all degrade to undefined or a filings-only
 *     block, never a throw) + the no-filings short-circuit that skips the heavy
 *     digest synthesis.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  computeObservationsImpact,
  flattenObservationCitablePatterns,
  patternRefToIssueId,
  resolveObservationsImpact,
  OBS_IMPACT_KILL_ENV,
  SURFACING_BASIS_NOTE,
  type DigestPatternView,
  type GroundedIdeaRow,
  type ObservationFiling,
  type ObservationImpactDeps,
} from './observation-impact-leg';
import type { StateOfHiveDigest } from './corpus-digest';
import type { MetaPattern } from './types';

function emptyDigest(over: Partial<StateOfHiveDigest> = {}): StateOfHiveDigest {
  return {
    generatedAt: '2026-07-11T00:00:00.000Z',
    corpus: {
      completions: 0,
      reverts: 0,
      frictionCaptured: 0,
      deferrals: 0,
      spendUsd: 0,
      spendBuckets: 0,
      observations: 0,
      rubrics: 0,
    },
    recurringFriction: [],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    reverts: [],
    rubricRatings: [],
    rubricGaps: [],
    headline: 'test',
    ...over,
  };
}

function pat(ref: string, over: Partial<MetaPattern> = {}): MetaPattern {
  return { summary: `pattern ${ref}`, ref, weight: 1, ...over };
}

function makeDeps(
  opts: {
    filings?: ObservationFiling[];
    digest?: StateOfHiveDigest;
    grounded?: GroundedIdeaRow[];
    filingsThrows?: boolean;
    digestThrows?: boolean;
    groundedThrows?: boolean;
  } = {},
): ObservationImpactDeps & {
  loadFilings: ReturnType<typeof vi.fn>;
  synthesizeDigest: ReturnType<typeof vi.fn>;
  loadGroundedIdeas: ReturnType<typeof vi.fn>;
} {
  const loadFilings = vi.fn(async (): Promise<ObservationFiling[]> => {
    if (opts.filingsThrows) throw new Error('PG down');
    return opts.filings ?? [];
  });
  const synthesizeDigest = vi.fn(async (): Promise<StateOfHiveDigest> => {
    if (opts.digestThrows) throw new Error('digest boom');
    return opts.digest ?? emptyDigest();
  });
  const loadGroundedIdeas = vi.fn(async (): Promise<GroundedIdeaRow[]> => {
    if (opts.groundedThrows) throw new Error('idea read boom');
    return opts.grounded ?? [];
  });
  return { loadFilings, synthesizeDigest, loadGroundedIdeas };
}

const prevKill = process.env[OBS_IMPACT_KILL_ENV];
afterEach(() => {
  if (prevKill === undefined) delete process.env[OBS_IMPACT_KILL_ENV];
  else process.env[OBS_IMPACT_KILL_ENV] = prevKill;
});

describe('patternRefToIssueId — pure wi: drill-back parse', () => {
  it('strips the wi: prefix to the engineer_issue id', () => {
    expect(patternRefToIssueId('wi:EI-123')).toBe('EI-123');
  });
  it('returns null for a non-wi ref (usage:/plan:/rubric:/niche:)', () => {
    expect(patternRefToIssueId('rubric:r1#c1')).toBeNull();
    expect(patternRefToIssueId('plan:some-plan#P-001')).toBeNull();
    expect(patternRefToIssueId('usage:papercusp/su')).toBeNull();
  });
  it('returns null for a bare / empty wi: ref', () => {
    expect(patternRefToIssueId('wi:')).toBeNull();
    expect(patternRefToIssueId('wi:   ')).toBeNull();
  });
});

describe('flattenObservationCitablePatterns — the 3 friction-derived lanes only', () => {
  it('pulls recurringFriction + capabilityGaps + rubricGaps, skips the non-observation lanes', () => {
    const digest = emptyDigest({
      recurringFriction: [pat('wi:EI-1', { category: 'recurring-friction' })],
      capabilityGaps: [pat('wi:EI-2', { category: 'capability-gap' })],
      rubricGaps: [pat('wi:EI-3')], // rubricGaps carry no category
      // These must NOT surface — their refs can never name an observation:
      timeTokenSinks: [pat('usage:papercusp/su', { category: 'time-token-sink' })],
      chronicDeferrals: [pat('plan:p#P-1', { category: 'chronic-deferral' })],
      reverts: [pat('wi:F-99')],
      rubricRatings: [pat('rubric:r#c', { category: 'rubric-rating' })],
    });
    const flat = flattenObservationCitablePatterns(digest);
    expect(flat.map((p) => p.ref).sort()).toEqual(['wi:EI-1', 'wi:EI-2', 'wi:EI-3']);
    expect(flat.find((p) => p.ref === 'wi:EI-3')?.category).toBeUndefined();
  });
});

describe('computeObservationsImpact — the pure funnel', () => {
  const filings: ObservationFiling[] = [
    { id: 'EI-1', title: 'lock contention on cold recycle', filedAtMs: 100 },
    { id: 'EI-2', title: 'sidecar cold-load forfeits the read', filedAtMs: 200 },
    { id: 'EI-9', title: 'unrelated, never surfaced', filedAtMs: 300 },
  ];

  it('surfaces filings that a pattern ref cites, ignoring patterns for others', () => {
    const patterns: DigestPatternView[] = [
      { ref: 'wi:EI-1', summary: 'p1', category: 'recurring-friction', weight: 1 },
      { ref: 'wi:EI-2', summary: 'p2', weight: 0.5 },
      { ref: 'wi:EI-500', summary: 'someone else', weight: 1 }, // not my filing
    ];
    const res = computeObservationsImpact(filings, patterns, []);
    expect(res.patterns.map((p) => p.citesObservationId).sort()).toEqual(['EI-1', 'EI-2']);
    expect(res.summary.surfacedAsPattern).toBe(2);
    expect(res.summary.filings).toBe(3);
    expect(res.summary.ideasGrounded).toBe(0);
  });

  it('grounds an idea only via the CITING patterns it addresses, scoping via-refs', () => {
    const patterns: DigestPatternView[] = [{ ref: 'wi:EI-1', summary: 'p1', weight: 1 }];
    const ideas: GroundedIdeaRow[] = [
      {
        ideaId: 'idea-a',
        title: 'fix the cold recycle',
        routedRef: 'wi:F-100',
        origin: 'scout',
        outcome: 'won',
        // grounds on my citing pattern AND on an unrelated one — only the citing ref survives.
        addressesPatternRefs: ['wi:EI-1', 'wi:EI-777'],
      },
    ];
    const res = computeObservationsImpact(filings, patterns, ideas);
    expect(res.ideas).toEqual([
      {
        ideaId: 'idea-a',
        title: 'fix the cold recycle',
        routedRef: 'wi:F-100',
        origin: 'scout',
        outcome: 'won',
        viaPatternRefs: ['wi:EI-1'],
      },
    ]);
    expect(res.summary.ideasGrounded).toBe(1);
    expect(res.summary.shipped).toBe(1); // outcome 'won'
  });

  it('excludes an idea that grounds only on a NON-citing pattern', () => {
    const patterns: DigestPatternView[] = [{ ref: 'wi:EI-1', summary: 'p1', weight: 1 }];
    const ideas: GroundedIdeaRow[] = [
      { ideaId: 'idea-b', routedRef: 'wi:F-2', outcome: 'pending', addressesPatternRefs: ['wi:EI-777'] },
    ];
    const res = computeObservationsImpact(filings, patterns, ideas);
    expect(res.ideas).toEqual([]);
    expect(res.summary.ideasGrounded).toBe(0);
    expect(res.summary.shipped).toBe(0);
  });

  it('counts only won ideas as shipped', () => {
    const patterns: DigestPatternView[] = [{ ref: 'wi:EI-1', summary: 'p1', weight: 1 }];
    const ideas: GroundedIdeaRow[] = [
      { ideaId: 'w', routedRef: 'wi:F-1', outcome: 'won', addressesPatternRefs: ['wi:EI-1'] },
      { ideaId: 'l', routedRef: 'wi:F-2', outcome: 'lost', addressesPatternRefs: ['wi:EI-1'] },
      { ideaId: 'p', routedRef: 'wi:F-3', outcome: 'pending', addressesPatternRefs: ['wi:EI-1'] },
    ];
    const res = computeObservationsImpact(filings, patterns, ideas);
    expect(res.summary.ideasGrounded).toBe(3);
    expect(res.summary.shipped).toBe(1);
  });
});

describe('resolveObservationsImpact — impure leg (fail-open, short-circuit)', () => {
  const who = 'su-01293';

  it('walks the full funnel with injected deps', async () => {
    const filings: ObservationFiling[] = [{ id: 'EI-1', title: 't', filedAtMs: Date.now() }];
    const digest = emptyDigest({ recurringFriction: [pat('wi:EI-1', { category: 'recurring-friction' })] });
    const grounded: GroundedIdeaRow[] = [
      { ideaId: 'idea-a', routedRef: 'wi:F-1', outcome: 'won', addressesPatternRefs: ['wi:EI-1'] },
    ];
    const deps = makeDeps({ filings, digest, grounded });
    const res = await resolveObservationsImpact(who, {}, deps);
    expect(res?.summary).toEqual({
      filings: 1,
      surfacedAsPattern: 1,
      ideasGrounded: 1,
      shipped: 1,
      // Digest WAS read here, so the ceiling is measured — no slotsUnknown marker.
      basis: {
        citableSlotsHiveWide: 1,
        observationNamingSlots: 1,
        note: SURFACING_BASIS_NOTE,
      },
    });
    expect(res?.error).toBeUndefined();
    // grounded-ideas fetch was scoped to the citing ref only.
    expect(deps.loadGroundedIdeas).toHaveBeenCalledWith(['wi:EI-1']);
  });

  it('short-circuits an empty-filings agent WITHOUT synthesizing the digest', async () => {
    const deps = makeDeps({ filings: [] });
    const res = await resolveObservationsImpact(who, {}, deps);
    expect(res).toEqual({
      filings: [],
      patterns: [],
      ideas: [],
      summary: {
        filings: 0,
        surfacedAsPattern: 0,
        ideasGrounded: 0,
        shipped: 0,
        // Digest never synthesized on this path ⇒ the ceiling is unknown, not measured-zero.
        basis: {
          citableSlotsHiveWide: 0,
          observationNamingSlots: 0,
          slotsUnknown: true,
          note: SURFACING_BASIS_NOTE,
        },
      },
    });
    expect(deps.synthesizeDigest).not.toHaveBeenCalled();
    expect(deps.loadGroundedIdeas).not.toHaveBeenCalled();
  });

  it('does not fetch grounded ideas when no pattern cites my filings', async () => {
    const filings: ObservationFiling[] = [{ id: 'EI-1', filedAtMs: Date.now() }];
    const digest = emptyDigest({ recurringFriction: [pat('wi:EI-OTHER')] }); // cites someone else
    const deps = makeDeps({ filings, digest });
    const res = await resolveObservationsImpact(who, {}, deps);
    expect(res?.summary.surfacedAsPattern).toBe(0);
    expect(deps.loadGroundedIdeas).not.toHaveBeenCalled();
  });

  it('fails open to filings-only + error when the digest synthesis throws', async () => {
    const filings: ObservationFiling[] = [{ id: 'EI-1', filedAtMs: Date.now() }];
    const deps = makeDeps({ filings, digestThrows: true });
    const res = await resolveObservationsImpact(who, {}, deps);
    expect(res?.filings).toHaveLength(1);
    expect(res?.patterns).toEqual([]);
    expect(res?.ideas).toEqual([]);
    expect(res?.error).toBe('digest boom');
  });

  it('fails open (patterns kept, ideas empty, error set) when the grounded-idea read throws', async () => {
    const filings: ObservationFiling[] = [{ id: 'EI-1', filedAtMs: Date.now() }];
    const digest = emptyDigest({ recurringFriction: [pat('wi:EI-1')] });
    const deps = makeDeps({ filings, digest, groundedThrows: true });
    const res = await resolveObservationsImpact(who, {}, deps);
    expect(res?.patterns.map((p) => p.citesObservationId)).toEqual(['EI-1']);
    expect(res?.ideas).toEqual([]);
    expect(res?.error).toBe('idea read boom');
  });

  it('fails open to an empty block when loadFilings throws', async () => {
    const deps = makeDeps({ filingsThrows: true });
    const res = await resolveObservationsImpact(who, {}, deps);
    expect(res).toEqual({
      filings: [],
      patterns: [],
      ideas: [],
      summary: {
        filings: 0,
        surfacedAsPattern: 0,
        ideasGrounded: 0,
        shipped: 0,
        // Digest never synthesized on this path ⇒ the ceiling is unknown, not measured-zero.
        basis: {
          citableSlotsHiveWide: 0,
          observationNamingSlots: 0,
          slotsUnknown: true,
          note: SURFACING_BASIS_NOTE,
        },
      },
    });
  });

  it('returns undefined for a blank createdBy (no work to do)', async () => {
    const deps = makeDeps({});
    expect(await resolveObservationsImpact('   ', {}, deps)).toBeUndefined();
    expect(deps.loadFilings).not.toHaveBeenCalled();
  });

  it('honors the PAPERCUSP_SU_OBS_IMPACT=off kill switch even with deps', async () => {
    process.env[OBS_IMPACT_KILL_ENV] = 'off';
    const deps = makeDeps({ filings: [{ id: 'EI-1', filedAtMs: Date.now() }] });
    expect(await resolveObservationsImpact(who, {}, deps)).toBeUndefined();
    expect(deps.loadFilings).not.toHaveBeenCalled();
  });

  it('is VITEST-inert with no deps injected — never touches the real digest/PG', async () => {
    expect(await resolveObservationsImpact(who)).toBeUndefined();
  });
});

/**
 * EI-20305547503222578 — `surfacedAsPattern` on its own is uninterpretable, because the
 * ceiling it counts against is tiny and shared by every filer (the digest collapses each
 * cluster to ONE exemplar and caps each lane at `perCategory ?? 20`). The modal reading of
 * a HEALTHY pipeline is therefore 0, previously indistinguishable from a dead one. These
 * guards pin the two properties that make the added denominator worth anything: it is
 * HIVE-WIDE (not a restatement of the numerator), and a ceiling that was never measured is
 * reported UNKNOWN rather than as a second misleading zero.
 */
describe('summary.basis — the denominator that makes surfacedAsPattern readable', () => {
  const mine: ObservationFiling[] = [{ id: 'EI-1', filedAtMs: 100 }];

  it('counts the HIVE-WIDE slot population, not the caller-citing subset', () => {
    const patterns: DigestPatternView[] = [
      { ref: 'wi:EI-1', summary: 'mine' }, // the one citing me
      { ref: 'wi:EI-500', summary: 'someone else' },
      { ref: 'wi:EI-501', summary: 'someone else again' },
    ];
    const res = computeObservationsImpact(mine, patterns, []);

    expect(res.summary.surfacedAsPattern).toBe(1);
    expect(res.summary.basis.observationNamingSlots).toBe(3);
    // THE POINT: a denominator equal to the numerator would carry no information at all —
    // it would just restate my own tally and leave a 0 exactly as unreadable as before.
    expect(res.summary.basis.observationNamingSlots).toBeGreaterThan(res.summary.surfacedAsPattern);
    expect(res.summary.basis.slotsUnknown).toBeUndefined();
  });

  it('separates slots that can name an observation from citable-lane slots that cannot', () => {
    // A friction cluster with no resolvable newest member gets a `friction:<sig>` ref
    // (corpus-digest), so it occupies a citable-lane slot that can never name a filing.
    const patterns: DigestPatternView[] = [
      { ref: 'wi:EI-1', summary: 'names an observation' },
      { ref: 'friction:some-cluster-signature', summary: 'names no observation' },
    ];
    const res = computeObservationsImpact(mine, patterns, []);

    expect(res.summary.basis.citableSlotsHiveWide).toBe(2);
    expect(res.summary.basis.observationNamingSlots).toBe(1);
  });

  it('reports an UNMEASURED ceiling as unknown, not as zero, when the digest leg fails', async () => {
    const deps = makeDeps({ filings: [{ id: 'EI-1', filedAtMs: Date.now() }], digestThrows: true });
    const failed = await resolveObservationsImpact('su-01293', {}, deps);

    expect(failed?.error).toBeDefined();
    expect(failed?.summary.surfacedAsPattern).toBe(0);
    // Without this marker the fail-open path would assert a measured ceiling of 0 — the
    // same false-zero class this whole block exists to remove, one level down.
    expect(failed?.summary.basis.slotsUnknown).toBe(true);

    // CALIBRATION: a predicate that answered "unknown" unconditionally would pass the
    // assertion above while telling nobody anything. The healthy path must still be
    // reported as MEASURED through the very same field.
    const healthy = await resolveObservationsImpact(
      'su-01293',
      {},
      makeDeps({
        filings: [{ id: 'EI-1', filedAtMs: Date.now() }],
        digest: emptyDigest({ recurringFriction: [pat('wi:EI-1')] }),
      }),
    );
    expect(healthy?.error).toBeUndefined();
    expect(healthy?.summary.basis.slotsUnknown).toBeUndefined();
    expect(healthy?.summary.basis.observationNamingSlots).toBe(1);
  });

  it('reports unknown on the no-filings short-circuit, which never reads the digest', async () => {
    const deps = makeDeps({ filings: [] });
    const res = await resolveObservationsImpact('su-01293', {}, deps);

    expect(res?.summary.filings).toBe(0);
    expect(res?.summary.basis.slotsUnknown).toBe(true);
    // The short-circuit's whole purpose is skipping the heavy synthesis — so the ceiling
    // is genuinely unmeasured here, and the marker is what says so.
    expect(deps.synthesizeDigest).not.toHaveBeenCalled();
  });

  it('carries the mechanism note, and keeps numbers out of it so it cannot drift', () => {
    const res = computeObservationsImpact(mine, [{ ref: 'wi:EI-1', summary: 'p' }], []);
    expect(res.summary.basis.note).toBe(SURFACING_BASIS_NOTE);
    // Numbers belong in the derived fields; a note quoting a cap would rot the moment
    // `perCategory` changed, and would be believed because it reads like a measurement.
    expect(SURFACING_BASIS_NOTE).not.toMatch(/\d/);
  });
});
