/**
 * Coverage for admin-test-suites' pure registry helpers: listAdminTestSuites,
 * expandAdminTestSuiteSelection ('all-safe' → the safeDefault subset, else the
 * single id), and the isAdminTestSuiteId guard.
 */
import { describe, expect, it } from 'vitest';
import {
  listAdminTestSuites,
  expandAdminTestSuiteSelection,
  isAdminTestSuiteId,
  pickBridgePid,
  warmRouteResult,
  gradeChaosSummary,
  type ChaosRecorderSummary,
  type RouteMeasurement,
  type RouteNavKind,
} from './admin-test-suites';
import { DESKTOP_PERF_BUDGETS } from './system-health/desktop-perf-budgets';

const suites = listAdminTestSuites();

describe('listAdminTestSuites', () => {
  it('returns a non-empty registry, each with an id + safeDefault flag', () => {
    expect(suites.length).toBeGreaterThan(0);
    for (const s of suites) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.safeDefault).toBe('boolean');
    }
  });
});

describe('expandAdminTestSuiteSelection', () => {
  it("'all-safe' expands to exactly the safeDefault suites", () => {
    const expanded = expandAdminTestSuiteSelection('all-safe');
    const expectedSafe = suites.filter((s) => s.safeDefault).map((s) => s.id).sort();
    expect([...expanded].sort()).toEqual(expectedSafe);
  });

  it('a specific id expands to just that id', () => {
    const id = suites[0].id;
    expect(expandAdminTestSuiteSelection(id)).toEqual([id]);
  });
});

describe('isAdminTestSuiteId', () => {
  it('accepts a registered id, rejects anything else', () => {
    expect(isAdminTestSuiteId(suites[0].id)).toBe(true);
    expect(isAdminTestSuiteId('definitely-not-a-suite')).toBe(false);
  });
});

/**
 * pickBridgePid — the suite runner's instance-pinning decision. On a box
 * running several Tauri desktops (the owner's seat + agents' Xvfb instances)
 * an unpinned run would let tauri-agent-tools' discoverBridge() pick an
 * arbitrary window; these cases pin the contract.
 */
describe('pickBridgePid (suite-run bridge pinning)', () => {
  const noAncestors = new Set<number>();

  it('explicit request pin wins over everything', () => {
    expect(pickBridgePid({ explicit: 42, envPid: 7, live: [1, 2, 3], ancestors: noAncestors })).toBe(42);
  });

  it('env pin wins when no explicit pin', () => {
    expect(pickBridgePid({ explicit: null, envPid: 7, live: [1, 2], ancestors: noAncestors })).toBe(7);
  });

  it('no live bridge → null (checks surface the normal bridge-unreachable error)', () => {
    expect(pickBridgePid({ explicit: null, envPid: null, live: [], ancestors: noAncestors })).toBeNull();
  });

  it('exactly one live bridge → pinned to it', () => {
    expect(pickBridgePid({ explicit: null, envPid: null, live: [123], ancestors: noAncestors })).toBe(123);
  });

  it('multiple bridges → the one on the operator ancestry (dev-shell sidecar) wins', () => {
    expect(pickBridgePid({ explicit: null, envPid: null, live: [10, 20, 30], ancestors: new Set([5, 20]) })).toBe(20);
  });

  it('multiple bridges, none ours → throws instead of driving an arbitrary window', () => {
    expect(() => pickBridgePid({ explicit: null, envPid: null, live: [10, 20], ancestors: noAncestors })).toThrow(/refusing to drive/i);
  });
});

/**
 * WI-39494 — a warm-route budget must never be applied to a COLD measurement.
 *
 * `measureRoute` chooses between an in-page `history.pushState` transition and a
 * full webview document load by comparing path ROOTS, and a redirecting target
 * defeats that heuristic permanently: `/harness` throws a `beforeLoad` redirect
 * to `/adv`, so the landing root (`adv`) never equals the requested root
 * (`harness`) and EVERY pass reloads the document. The "warm" pass was therefore
 * timing an SPA cold boot, and the resulting 2912ms was graded against the
 * 1500ms warm budget and filed as a 1.94x regression — while two sibling routes
 * measured genuinely warm at 451-517ms.
 *
 * The guard is at the grading seam rather than on the one route, so ANY future
 * warm-route check pointed at a redirecting/aliased path skips loudly instead of
 * emitting a cold number into the warm trend series.
 */
describe('warmRouteResult (cold-measurement guard)', () => {
  const page = {
    href: 'http://127.0.0.1:33700/adv?tab=harnesses&slug=papercup',
    h1: [] as string[],
    domNodes: 1122,
    hasHarnessRoot: false,
    details: [] as string[],
    summary: 'harnesses tab',
  };
  const measurement = (navKind: RouteNavKind, elapsedMs: number): RouteMeasurement => ({
    ok: true,
    elapsedMs,
    page,
    stabilized: true,
    navKind,
  });

  const overBudget = DESKTOP_PERF_BUDGETS.warmRouteSettleMs * 2;
  const underBudget = Math.floor(DESKTOP_PERF_BUDGETS.warmRouteSettleMs / 3);

  it('SKIPS a document-load measurement and emits NO measure, however over budget', () => {
    const res = warmRouteResult('route:harness-warm', 'Warm harness route', measurement('document-load', overBudget));
    expect(res.status).toBe('skip');
    // The critical half: a cold number must not enter the trend series at all.
    expect(res.measures ?? []).toEqual([]);
    expect(res.actual).toContain('COLD');
  });

  it('SKIPS a document-load measurement even when it would have PASSED — the flattering direction is a false green', () => {
    const res = warmRouteResult('route:harness-warm', 'Warm harness route', measurement('document-load', underBudget));
    expect(res.status).toBe('skip');
    expect(res.measures ?? []).toEqual([]);
  });

  // Calibration: the guard must not swallow real warm measurements, or the two
  // assertions above would also pass against a warmRouteResult that skips
  // everything.
  it('GRADES an in-page measurement — passing under budget, failing over it', () => {
    const pass = warmRouteResult('route:harness-warm', 'Warm harness route', measurement('in-page', underBudget));
    expect(pass.status).toBe('pass');
    expect(pass.measures).toHaveLength(1);
    expect(pass.measures?.[0]).toMatchObject({ value: underBudget, budget: DESKTOP_PERF_BUDGETS.warmRouteSettleMs, ok: true });

    const fail = warmRouteResult('route:harness-warm', 'Warm harness route', measurement('in-page', overBudget));
    expect(fail.status).toBe('fail');
    expect(fail.measures?.[0]).toMatchObject({ value: overBudget, ok: false });
  });

  it('an UNMEASURED result still skips, regardless of navKind', () => {
    for (const navKind of ['in-page', 'document-load'] as const) {
      const res = warmRouteResult('route:harness-warm', 'Warm harness route', {
        ...measurement(navKind, 10_695),
        ok: false,
      });
      expect(res.status).toBe('skip');
      expect(res.measures ?? []).toEqual([]);
    }
  });
});

/**
 * WI-39495 — the chaos INP legs must never be graded against zeroes nobody observed.
 *
 * The chaos driver is gremlins.js, which SYNTHESISES its clicks, and Event Timing
 * ignores untrusted events — verified 2026-08-16 in this WebKitGTK with one
 * button, one observer and a 60ms-blocking handler: 2 synthetic clicks produced
 * 0 entries, 2 real xdotool clicks produced 6 (click dur=64ms, interactionId
 * 1285). So maxInp/p95Inp are permanently 0 and the old `maxInp <= budget &&
 * p95Inp <= budget` legs PASSED trivially, forever, having never once been
 * evaluated. They currently hide behind genuine max-frame breaches; fixing those
 * would have turned the whole check green with INP still unmeasured.
 */
describe('gradeChaosSummary (unmeasured-INP guard)', () => {
  const base: ChaosRecorderSummary = {
    clicks: 12,
    durationMs: 5000,
    inpSamples: 0,
    maxInp: 0,
    p95Inp: 0,
    longTasks: 0,
    errors: 0,
    reloads: 0,
    frameDrops: 0,
    maxFrameMs: 50,
    routes: ['/adv'],
  };
  const grade = (over: Partial<ChaosRecorderSummary>) =>
    gradeChaosSummary({ ...base, ...over }, 'Chaos-clicking X', 'chaos:x:', ['detail']);

  const inpKeys = (res: ReturnType<typeof grade>) =>
    (res.measures ?? []).map((m) => m.key).filter((k) => k.includes('inp'));

  it('SKIPS instead of passing when clicks happened but zero interactions were observed', () => {
    const res = grade({ clicks: 12, inpSamples: 0 });
    expect(res.status).toBe('skip');
    expect(res.actual).toContain('UNMEASURED');
    // The critical half: no INP measure may enter the trend series as a clean 0.
    expect(inpKeys(res)).toEqual([]);
    // The legs that WERE genuinely measured still get reported.
    expect((res.measures ?? []).map((m) => m.key)).toEqual(['chaos:x:max-frame', 'chaos:x:frame-drops']);
  });

  it('still FAILS on a real breach — an unmeasurable INP must not launder a genuine failure into a skip', () => {
    const framed = grade({ inpSamples: 0, maxFrameMs: 512 });
    expect(framed.status).toBe('fail');
    expect(inpKeys(framed)).toEqual([]);

    const errored = grade({ inpSamples: 0, errors: 3 });
    expect(errored.status).toBe('fail');

    // A surface that never hydrated is broken, not unmeasured.
    const dead = grade({ clicks: 0, inpSamples: 0 });
    expect(dead.status).toBe('fail');
  });

  // Calibration: without this, a gradeChaosSummary that skipped or failed
  // unconditionally would satisfy every assertion above.
  it('GRADES the INP legs normally once interactions ARE observed', () => {
    const pass = grade({ inpSamples: 9, maxInp: 40, p95Inp: 32 });
    expect(pass.status).toBe('pass');
    expect(inpKeys(pass)).toEqual(['chaos:x:inp-p95', 'chaos:x:inp-max']);
    expect(pass.actual).toContain('9 samples');

    const breach = grade({ inpSamples: 9, maxInp: 9_000, p95Inp: 8_000 });
    expect(breach.status).toBe('fail');
    expect(inpKeys(breach)).toEqual(['chaos:x:inp-p95', 'chaos:x:inp-max']);
  });
});
