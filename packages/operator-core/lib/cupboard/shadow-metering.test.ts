/**
 * agent-economy-flywheel P-003 (E1, WI-10004287): the shadow statement pricing rules.
 * Rules under test come from plan decisions D-005, D-007 and D-009 (see shadow-metering.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHADOW_MARKUP_SHEET,
  type ShadowMarkupSheet,
  type ShadowUsageAggregate,
  buildShadowStatements,
  classifyShadowIdentity,
  splitShadowMarkup,
  usdToMicros,
} from './shadow-metering';

const WS = 'ws-a';
const MONTH = '2026-09';

function usage(over: Partial<ShadowUsageAggregate> = {}): ShadowUsageAggregate {
  return {
    workspaceId: WS,
    month: MONTH,
    attributed: true,
    agent: 'claude',
    profile: null,
    specificationLayerRefs: [],
    axisLayerRefs: [],
    costSource: 'provider',
    costMicros: 1_000_000,
    samples: 10,
    ...over,
  };
}

function only<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  return values[0] as T;
}

describe('splitShadowMarkup', () => {
  it('splits the suggested 20% markup with a 10% DAO share exactly', () => {
    expect(splitShadowMarkup(1_000_000, 2000, 1000)).toEqual({
      markupMicros: 200_000,
      daoMicros: 20_000,
      sellerMicros: 180_000,
    });
  });

  it('floors once and keeps dao + seller === markup for awkward amounts', () => {
    for (const base of [0, 1, 7, 49, 99_999, 123_456_789]) {
      const s = splitShadowMarkup(base, 2000, 1000);
      expect(s.markupMicros).toBe(Math.floor((base * 2000) / 10_000));
      expect(s.daoMicros + s.sellerMicros).toBe(s.markupMicros);
      expect(s.daoMicros).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuses fractional money and out-of-range basis points', () => {
    expect(() => splitShadowMarkup(1.5, 2000, 1000)).toThrow(RangeError);
    expect(() => splitShadowMarkup(-1, 2000, 1000)).toThrow(RangeError);
    expect(() => splitShadowMarkup(10, 10_001, 1000)).toThrow(RangeError);
    expect(() => splitShadowMarkup(10, 2000, -1)).toThrow(RangeError);
  });
});

describe('usdToMicros', () => {
  it('rounds to integer micro-USD and zeroes absent or negative cost', () => {
    expect(usdToMicros(0.0231)).toBe(23_100);
    expect(usdToMicros(1.0000004)).toBe(1_000_000);
    expect(usdToMicros(null)).toBe(0);
    expect(usdToMicros(Number.NaN)).toBe(0);
    expect(usdToMicros(-2)).toBe(0);
  });
});

describe('classifyShadowIdentity', () => {
  it('prices every named profession layer on its own line (stacking, D-007 point 2)', () => {
    const classes = classifyShadowIdentity(
      usage({ specificationLayerRefs: ['domain:seller-b', 'launch-adapter-compatibility', 'domain:seller-a', 'domain:seller-a'] }),
    );
    expect(classes.map((c) => c.identityClass)).toEqual(['domain:seller-a', 'domain:seller-b']);
    expect(classes.every((c) => c.basis === 'specification-layer' && c.markupBps === 2000)).toBe(true);
  });

  it('falls back to the profile class and marks it inferred when no profession layer exists', () => {
    const cls = only(classifyShadowIdentity(usage({ profile: 'engineer', specificationLayerRefs: ['launch-adapter-compatibility'] })));
    expect(cls).toEqual({ identityClass: 'papercusp-engineer', markupBps: 2000, basis: 'inferred-profile' });
  });

  it('prices nothing for unattributed usage or an unknown profile', () => {
    expect(classifyShadowIdentity(usage({ attributed: false, profile: 'engineer' }))).toEqual([]);
    expect(classifyShadowIdentity(usage({ profile: 'mystery' }))).toEqual([]);
  });
});

describe('buildShadowStatements', () => {
  it('produces a bill-grade statement for billed, fully attributed, spec-layer usage', () => {
    const st = only(buildShadowStatements([usage({ specificationLayerRefs: ['domain:seller-a'] })]));
    expect(st.sheetVersion).toBe(SHADOW_MARKUP_SHEET.version);
    expect(only(st.lines)).toMatchObject({
      identityClass: 'domain:seller-a',
      baseMicros: 1_000_000,
      markupMicros: 200_000,
      daoMicros: 20_000,
      sellerMicros: 180_000,
      samples: 10,
    });
    expect(st.totals).toEqual({ markupMicros: 200_000, daoMicros: 20_000, sellerMicros: 180_000, wouldHaveChargedMicros: 200_000 });
    expect(st.cleanliness).toMatchObject({ verdict: 'bill-grade', reasons: [], attributedShareBps: 10_000, billGradeCostShareBps: 10_000 });
  });

  it('bills each stacked priced layer its own markup on the same inference', () => {
    const st = only(buildShadowStatements([usage({ specificationLayerRefs: ['domain:seller-a', 'domain:seller-b'] })]));
    expect(st.lines.map((l) => [l.identityClass, l.markupMicros])).toEqual([
      ['domain:seller-a', 200_000],
      ['domain:seller-b', 200_000],
    ]);
    expect(st.totals.wouldHaveChargedMicros).toBe(400_000);
    expect(st.inference.costMicros).toBe(1_000_000);
  });

  it('prices axis layers and tool calls at zero but still itemizes them (D-009 points 3-4)', () => {
    const st = only(
      buildShadowStatements(
        [usage({ specificationLayerRefs: ['domain:seller-a'], axisLayerRefs: ['autonomy:su.mode-auto', 'fleet-posture:su.fleet-leader'] })],
        [
          { workspaceId: WS, month: MONTH, attributed: true, calls: 40 },
          { workspaceId: WS, month: MONTH, attributed: false, calls: 3 },
        ],
      ),
    );
    expect(st.lines.map((l) => l.identityClass)).toEqual(['domain:seller-a']);
    expect(st.zeroPriced.axisLayers).toEqual([
      { layerRef: 'autonomy:su.mode-auto', baseMicros: 1_000_000 },
      { layerRef: 'fleet-posture:su.fleet-leader', baseMicros: 1_000_000 },
    ]);
    expect(st.zeroPriced.toolCalls).toEqual({ attributed: 40, unattributed: 3 });
    expect(st.totals.markupMicros).toBe(200_000);
  });

  it("reports today's reality as not bill-grade: estimated cost and an inferred base identity", () => {
    const st = only(
      buildShadowStatements([usage({ profile: 'engineer', costSource: 'estimated', specificationLayerRefs: ['launch-adapter-compatibility'] })]),
    );
    expect(only(st.lines)).toMatchObject({ identityClass: 'papercusp-engineer', basis: 'inferred-profile', markupMicros: 200_000 });
    expect(st.cleanliness.verdict).toBe('not-bill-grade');
    expect(st.cleanliness.reasons).toEqual(['estimated-cost', 'inferred-base-identity']);
    expect(st.cleanliness.inferredShareBps).toBe(10_000);
    expect(st.cleanliness.billGradeCostShareBps).toBe(0);
  });

  it('keeps unattributed and unclassified cost out of the lines and names both gaps', () => {
    const st = only(
      buildShadowStatements([
        usage({ specificationLayerRefs: ['domain:seller-a'], costMicros: 900_000 }),
        usage({ attributed: false, costMicros: 60_000 }),
        usage({ profile: 'mystery', costMicros: 40_000 }),
      ]),
    );
    expect(only(st.lines).baseMicros).toBe(900_000);
    expect(st.inference.costMicros).toBe(1_000_000);
    expect(st.cleanliness).toMatchObject({
      verdict: 'not-bill-grade',
      reasons: ['unattributed-cost', 'unclassified-identity'],
      attributedShareBps: 9400,
      unattributedMicros: 60_000,
      unclassifiedMicros: 40_000,
    });
  });

  it('groups by workspace and month, sorted, and rounds once per line rather than per sample', () => {
    const rows = [
      usage({ workspaceId: 'ws-b', specificationLayerRefs: ['domain:x'], costMicros: 3 }),
      usage({ month: '2026-10', specificationLayerRefs: ['domain:x'], costMicros: 3 }),
      ...Array.from({ length: 5 }, () => usage({ specificationLayerRefs: ['domain:x'], costMicros: 3, samples: 1 })),
    ];
    const statements = buildShadowStatements(rows);
    expect(statements.map((s) => `${s.workspaceId}/${s.month}`)).toEqual(['ws-a/2026-09', 'ws-a/2026-10', 'ws-b/2026-09']);
    // 5 x 3 micros aggregated = 15 -> floor(15 * 0.2) = 3; per-sample flooring would give 0.
    const first = statements[0]!;
    expect(only(first.lines)).toMatchObject({ baseMicros: 15, markupMicros: 3, samples: 5 });
  });

  it('emits a statement for a month with tool activity but no inference, flagged no-usage', () => {
    const st = only(buildShadowStatements([], [{ workspaceId: WS, month: MONTH, attributed: true, calls: 2 }]));
    expect(st.lines).toEqual([]);
    expect(st.totals.wouldHaveChargedMicros).toBe(0);
    expect(st.cleanliness).toMatchObject({ verdict: 'not-bill-grade', reasons: ['no-usage'] });
  });

  it('prices from the sheet it is given, so a sheet revision changes the statement', () => {
    const sheet: ShadowMarkupSheet = { ...SHADOW_MARKUP_SHEET, version: 'test-r2', suggestedMarkupBps: 1500, daoShareBps: 2000 };
    const st = only(buildShadowStatements([usage({ specificationLayerRefs: ['domain:seller-a'] })], [], sheet));
    expect(st.sheetVersion).toBe('test-r2');
    expect(only(st.lines)).toMatchObject({ markupBps: 1500, markupMicros: 150_000, daoMicros: 30_000, sellerMicros: 120_000 });
  });
});

describe('SHADOW_MARKUP_SHEET', () => {
  it('matches the plan rulings (D-007 point 3) and prices no axis slot', () => {
    expect(SHADOW_MARKUP_SHEET.suggestedMarkupBps).toBe(2000);
    expect(SHADOW_MARKUP_SHEET.daoShareBps).toBe(1000);
    expect(Object.isFrozen(SHADOW_MARKUP_SHEET)).toBe(true);
    for (const slot of ['autonomy:', 'fleet-posture:', 'objective:', 'ideation:', 'kernel']) {
      expect(slot.startsWith(SHADOW_MARKUP_SHEET.pricedSpecificationLayerPrefix)).toBe(false);
    }
  });

  // WI-10004493: the sheet once named `billed`, a cost_source no writer emits, so no statement
  // could ever be bill-grade. Pin every bill-grade source to a value the usage writer assigns.
  it('names only bill-grade cost sources that a usage writer actually assigns', () => {
    const writer = readFileSync(
      new URL('../../../../libs/papercusp/packages/orchestrator/src/usage-sample-pg.ts', import.meta.url),
      'utf8',
    );
    const assigned = (source: string) =>
      writer.split('\n').some((line) => /\bcostSource\b/.test(line) && line.includes(`'${source}'`));
    // Controls: the matcher finds a source the writer does assign, and rejects the old dead value.
    expect(assigned('estimated')).toBe(true);
    expect(assigned('billed')).toBe(false);
    expect(SHADOW_MARKUP_SHEET.billGradeCostSources.length).toBeGreaterThan(0);
    for (const source of SHADOW_MARKUP_SHEET.billGradeCostSources) {
      expect(assigned(source), `bill-grade cost source '${source}' is never assigned by usage-sample-pg.ts`).toBe(true);
    }
  });
});
