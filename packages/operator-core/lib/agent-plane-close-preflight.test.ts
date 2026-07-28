/**
 * EI-18850142725126359 fix #4 — pre-flighting the ratchet at the close.
 *
 * The states this must tell apart are states a live box is not in: a gap item
 * closing while its metric is still blind, the same item closing after the
 * producer came online, and an empty series that can answer neither. So they are
 * constructed as literal series against a literal gap map — which is also why the
 * map is injectable: the real METRIC_KNOWN_GAPS legitimately empties as its gaps
 * get built, and a suite keyed off it would go vacuously green exactly then.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isPlaneGapItem,
  planeGapItemIds,
  selectPlaneGapItems,
  preflightPlaneClose,
  renderPlaneClosePreflightWarning,
  PLANE_GAP_TERMINAL_STATUSES,
  type PlaneGapMap,
  type PlaneSeriesPoint,
} from './agent-plane-close-preflight';
import { METRIC_KNOWN_GAPS } from './agent-plane-ratchet';
import { METRIC_SPECS, PLANE_METRIC_IDS, type PlaneMetricId } from './agent-plane-measurement';

/**
 * Two real metric ids, so the fixtures exercise the shipped id space.
 *
 * ⚠ CHOSEN BY SEMANTICS, NEVER BY INDEX — `PLANE_METRIC_IDS[0]`/`[1]` is how this
 * suite reds the fleet gate against an impl that is RIGHT. `windowOf` below stages
 * an uninterpretable window as exactly `{ interpretable: false, zeroReason:
 * 'nothing-eligible', fillRate: 0 }`, which is precisely the shape
 * `producerRanButNothingOccurred` reads as BENIGN for a metric whose eligibility is
 * the occurrence it measures. WI-6562 set `eligibilityIsOccurrence` on
 * `intent-action-divergence-sampling` — which happened to sit at index 1 — so the
 * "regression" the delta fixtures stage silently stopped registering, and two tests
 * failed carrying no hint that a metric SPEC, not the pre-flight, had moved.
 *
 * A companion-dependent metric (`interpretableOnlyWith`) is excluded for the same
 * reason: its verdict is decided cross-metric in the ratchet's second pass, so a
 * fixture built on one asserts something other than what it reads as asserting.
 *
 * Select on the property the fixtures actually require — a metric whose blindness
 * is unambiguously its own failure — and the ORDERING of the id list stops being
 * load-bearing for a suite that never meant to depend on it.
 */
const FAILABLE_METRIC_IDS = PLANE_METRIC_IDS.filter(
  (id) =>
    METRIC_SPECS[id].eligibilityIsOccurrence !== true &&
    METRIC_SPECS[id].interpretableOnlyWith === undefined,
);
const BLIND: PlaneMetricId = FAILABLE_METRIC_IDS[0];
const OTHER: PlaneMetricId = FAILABLE_METRIC_IDS[1];
const GAPS: PlaneGapMap = { [BLIND]: 'WI-9001' };

/** A window in which `blind` is uninterpretable and everything else is fine. */
function windowOf(
  at: string,
  over: Partial<Record<PlaneMetricId, boolean>> = {},
): PlaneSeriesPoint {
  return {
    measuredAt: at,
    metrics: PLANE_METRIC_IDS.map((id) => {
      const interpretable = over[id] ?? true;
      return {
        id,
        measuredAt: at,
        interpretable,
        fillRate: interpretable ? 0.5 : 0,
        zeroReason: interpretable ? null : ('nothing-eligible' as const),
      };
    }),
  };
}

const blindSeries = [windowOf('2026-07-28T01:00:00Z', { [BLIND]: false })];
const healedSeries = [
  windowOf('2026-07-28T01:00:00Z', { [BLIND]: false }),
  windowOf('2026-07-28T01:30:00Z'),
];

describe('isPlaneGapItem — the cheapness guard on the hot completion path', () => {
  it('is true only for an id the gap map actually names', () => {
    expect(isPlaneGapItem('WI-9001', GAPS)).toBe(true);
    expect(isPlaneGapItem('  WI-9001  ', GAPS)).toBe(true);
    expect(isPlaneGapItem('WI-9002', GAPS)).toBe(false);
  });

  it('never matches on empty or whitespace — a blank id must not scan as a gap', () => {
    expect(isPlaneGapItem('', GAPS)).toBe(false);
    expect(isPlaneGapItem('   ', GAPS)).toBe(false);
    expect(isPlaneGapItem('', {})).toBe(false);
  });

  it('reads the SHIPPED map by default — the wiring both close paths depend on', () => {
    // Declares its own vacuous pass: with an empty live map this asserts only
    // that nothing matches, which is correct but says nothing about the guard.
    const live = planeGapItemIds();
    for (const ref of live) expect(isPlaneGapItem(ref)).toBe(true);
    expect(isPlaneGapItem('WI-000000-not-a-real-item')).toBe(false);
    expect(live.every((r) => isPlaneGapItem(r, METRIC_KNOWN_GAPS))).toBe(true);
  });
});

describe('⚠ selectPlaneGapItems — the one call site allowed to select gap ids', () => {
  it('selects, trims and de-duplicates', () => {
    expect(selectPlaneGapItems(['WI-1234', ' WI-9001 ', 'WI-9001'], GAPS)).toEqual(['WI-9001']);
    expect(selectPlaneGapItems([], GAPS)).toEqual([]);
  });

  it('survives being reached the way the bug reached it — an INDEX in the map slot', () => {
    // The live pre-flight was first written `ids.filter(isPlaneGapItem)`, which hands
    // filter's index in as `gaps`: Object.values(0) is [], nothing ever matches, and
    // the guard degrades into a fully-green no-op that reports `not-a-gap-item` for
    // the one id it exists to catch. Only tsc noticed — no test could, because the
    // failure IS "the check finds nothing". Pinned here as the shape to never repeat.
    const viaFilter = ['WI-9001', 'WI-1234'].filter((id, i) =>
      isPlaneGapItem(id, i as unknown as PlaneGapMap),
    );
    expect(viaFilter, 'the broken shape must still be broken — this is the counter-example').toEqual([]);
    expect(selectPlaneGapItems(['WI-9001', 'WI-1234'], GAPS)).toEqual(['WI-9001']);
  });
});

describe('preflightPlaneClose — what closing this item does to the gate', () => {
  it('says nothing at all about an ordinary work-item', () => {
    const v = preflightPlaneClose({ closingIds: ['WI-1234'], series: blindSeries, gaps: GAPS });
    expect(v.outcome).toBe('not-a-gap-item');
    expect(v.gapItems).toEqual([]);
    expect(renderPlaneClosePreflightWarning(v)).toBeUndefined();
  });

  it('REDS THE GATE when the metric it excuses is still blind — the WI-6465 case', () => {
    const v = preflightPlaneClose({ closingIds: ['WI-9001'], series: blindSeries, gaps: GAPS });
    expect(v.outcome).toBe('reds-the-gate');
    expect(v.causes.map((c) => c.metric)).toEqual([BLIND]);
    expect(v.causes[0]).toMatchObject({ knownGap: 'WI-9001', verdict: 'never-interpretable' });
  });

  it('is SAFE once the producer came online — the exemption is genuinely spent', () => {
    const v = preflightPlaneClose({ closingIds: ['WI-9001'], series: healedSeries, gaps: GAPS });
    expect(v.outcome).toBe('safe');
    expect(v.causes).toEqual([]);
    expect(renderPlaneClosePreflightWarning(v)).toBeUndefined();
  });

  it('still reports the red when the row is ALREADY marked closed (a re-close)', () => {
    // Without the baseline exclusion the failure is present on BOTH sides of the
    // delta, cancels out, and a re-close of a still-blind gap reads as `safe`.
    const v = preflightPlaneClose({
      closingIds: ['WI-9001'],
      series: blindSeries,
      closedGaps: new Set(['WI-9001']),
      gaps: GAPS,
    });
    expect(v.outcome).toBe('reds-the-gate');
    expect(v.causes.map((c) => c.metric)).toEqual([BLIND]);
  });
});

describe('⚠ the vacuous pass this probe declares', () => {
  it('an EMPTY series is UNJUDGEABLE, never safe', () => {
    // Every metric judges `no-data`, judgeKnownGap returns not-applicable, and no
    // verdict is `fails` — so a naive delta would report SAFE for a close that
    // reds the gate the moment the sweep writes its next row.
    const v = preflightPlaneClose({ closingIds: ['WI-9001'], series: [], gaps: GAPS });
    expect(v.outcome).toBe('unjudgeable');
    expect(v.unjudgeable.map((u) => u.metric)).toEqual([BLIND]);
    expect(renderPlaneClosePreflightWarning(v)).toMatch(/could not look/);
  });

  it('a series with windows but NONE for this metric is also unjudgeable', () => {
    const missing: PlaneSeriesPoint[] = [
      {
        measuredAt: '2026-07-28T01:00:00Z',
        metrics: PLANE_METRIC_IDS.filter((id) => id !== BLIND).map((id) => ({
          id,
          measuredAt: '2026-07-28T01:00:00Z',
          interpretable: true,
          fillRate: 0.5,
          zeroReason: null,
        })),
      },
    ];
    const v = preflightPlaneClose({ closingIds: ['WI-9001'], series: missing, gaps: GAPS });
    expect(v.outcome).toBe('unjudgeable');
  });
});

describe('⚠ the delta property — a red already in flight is never charged to this close', () => {
  it('⚠ THE FIXTURE PREMISE: both ids must be metrics whose blindness genuinely FAILS', () => {
    // The recurrence guard for the defect that reds the gate here (WI-6568). The
    // two tests below can only stage a "pre-existing failure" with a metric that
    // actually fails when blind — and whether a given metric does is a property of
    // its SPEC, which moves independently of this file. Assert the premise where it
    // can name its own reason: without this, a spec change surfaces two paragraphs
    // down as `expected [] to include '<some metric>'`, which reads as a pre-flight
    // regression and sends the next reader into the wrong module entirely.
    expect(
      FAILABLE_METRIC_IDS.length,
      'fewer than two metrics whose uninterpretable window is a real failure — the delta fixtures below can no longer be built from the shipped id space; re-pin them against literal specs',
    ).toBeGreaterThanOrEqual(2);
    expect(BLIND).not.toBe(OTHER);
    for (const id of [BLIND, OTHER]) {
      expect(
        METRIC_SPECS[id].eligibilityIsOccurrence,
        `${id}: eligibility is the OCCURRENCE, so a 'nothing-eligible' window is a quiet fleet, not a dead producer — it cannot stage a regression`,
      ).not.toBe(true);
      expect(
        METRIC_SPECS[id].interpretableOnlyWith,
        `${id}: companion-dependent, so its verdict is decided cross-metric and this fixture would assert something other than what it says`,
      ).toBeUndefined();
    }
  });

  it('does not attribute an unrelated pre-existing failure to the closer', () => {
    // OTHER worked and then died: a `regressed` verdict, failing independently of
    // any close. Misattributing a candidate-independent failure is the whole
    // defect this item filed; committing it inside the fix would build the trap twice.
    const regressed = [
      windowOf('2026-07-28T01:00:00Z'),
      windowOf('2026-07-28T01:30:00Z', { [BLIND]: false, [OTHER]: false }),
    ];
    const v = preflightPlaneClose({ closingIds: ['WI-9001'], series: regressed, gaps: GAPS });
    expect(v.preExisting).toContain(OTHER);
    expect(v.causes.map((c) => c.metric)).not.toContain(OTHER);
  });

  it('a close that adds nothing to an already-red gate is not blamed for it', () => {
    const regressedOnly = [
      windowOf('2026-07-28T01:00:00Z'),
      windowOf('2026-07-28T01:30:00Z', { [OTHER]: false }),
    ];
    const v = preflightPlaneClose({ closingIds: ['WI-9001'], series: regressedOnly, gaps: GAPS });
    expect(v.outcome).toBe('safe');
    expect(v.causes).toEqual([]);
    expect(v.preExisting).toContain(OTHER);
  });
});

describe('the warning text — what the agent is actually told', () => {
  const warn = renderPlaneClosePreflightWarning(
    preflightPlaneClose({ closingIds: ['WI-9001'], series: blindSeries, gaps: GAPS })!,
  )!;

  it('leads with the fleet-wide consequence and names the metric', () => {
    expect(warn).toMatch(/WILL RED THE FLEET RELEASE GATE/);
    expect(warn).toContain(BLIND);
    expect(warn).toContain('WI-9001');
  });

  it('states the candidate-independence that cost the release-fixer the diagnosis', () => {
    expect(warn).toMatch(/INDEPENDENT of any commit/);
    expect(warn).toMatch(/no code change can green it/i);
  });

  it('names reopening as SANCTIONED and editing the map as not an exit', () => {
    expect(warn).toMatch(/SANCTIONED/);
    expect(warn).toMatch(/editing METRIC_KNOWN_GAPS[^\n]*is NOT one of them/);
  });

  it('routes the candidate check at pipeline_position with a MARKER, not the working tree', () => {
    // The trap this fix was built after: a change green on staging does not
    // protect the close, because the gate judges the candidate.
    expect(warn).toMatch(/dev:pipeline_position/);
    expect(warn).toMatch(/marker/);
    expect(warn).toMatch(/not against your working tree|does not protect the close/);
  });

  it('⚠ DISCLOSES that it read the DEPLOYED gap map — the reason it warns and never refuses', () => {
    // This disclosure is load-bearing, not decoration. It is the single fact that
    // makes warn-only correct rather than timid: the check cannot see an in-flight
    // map change, so a refusal keyed on it could block a correct close (WI-6545 was
    // exactly that close) with no override until a deploy.
    expect(warn).toMatch(/PROVENANCE/);
    expect(warn).toMatch(/DEPLOYED/);
    expect(warn).toMatch(/false alarm/);
  });
});

describe('⚠ it must predict what the GATE decides, not merely something reasonable', () => {
  it('uses the same terminal-status set as scripts/check-plane-ratchet.ts', () => {
    // A divergence here does not make this check wrong in a visible way — it makes
    // it confidently wrong, reporting `safe` for a close the gate then fails on.
    const src = readFileSync(
      path.join(__dirname, '../../../scripts/check-plane-ratchet.ts'),
      'utf8',
    );
    const literal = /const TERMINAL_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(literal, 'check-plane-ratchet.ts no longer declares TERMINAL_STATUSES as a literal Set — re-pin this guard').not.toBeNull();
    const gateStatuses = [...literal![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(gateStatuses.length).toBeGreaterThan(0);
    expect(new Set(gateStatuses)).toEqual(new Set(PLANE_GAP_TERMINAL_STATUSES));
  });

  it('scopes the series read by workspace ONLY, exactly as the gate does', () => {
    // A harness filter here would read a NARROWER series than the gate judges and
    // could report `safe` for a close the gate fails. Pinned against both sources.
    const mine = readFileSync(path.join(__dirname, 'agent-plane-close-preflight.ts'), 'utf8');
    const gate = readFileSync(
      path.join(__dirname, '../../../scripts/check-plane-ratchet.ts'),
      'utf8',
    );
    for (const [label, src] of [['pre-flight', mine], ['gate', gate]] as const) {
      const query = /FROM harness_shared\.agent_plane_measurements([\s\S]*?)ORDER BY/.exec(src);
      expect(query, `${label}: could not locate the measurements query`).not.toBeNull();
      expect(query![1], `${label}: the series read must not filter on harness_slug`).not.toMatch(
        /harness_slug/,
      );
    }
  });
});
