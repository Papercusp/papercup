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
  resolveTauriAgentToolsCommand,
  warmRouteResult,
  gradeChaosSummary,
  buildInteractionMeasureScript,
  applyAiExploreEvent,
  type AiExploreParserState,
  type ChaosRecorderSummary,
  type InteractionMeasureSpec,
  type RouteMeasurement,
  type RouteNavKind,
} from './admin-test-suites';
import { DESKTOP_PERF_BUDGETS } from './system-health/desktop-perf-budgets';

const suites = listAdminTestSuites();

function aiSummary(): Parameters<typeof applyAiExploreEvent>[0] {
  return {
    goal: 'test',
    steps: 0,
    totalMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    exitCode: null,
    errors: [] as string[],
    logs: [] as string[],
  };
}

function parserState(): AiExploreParserState {
  return { metricsSeen: false, metricsIncomplete: false };
}

describe('AI Explore usage presence', () => {
  it('keeps measured zero metrics distinct from an absent metrics frame', () => {
    const summary = aiSummary();
    const state = parserState();
    applyAiExploreEvent(summary, 'metrics', { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }, state);
    applyAiExploreEvent(summary, 'done', { totalMs: 10, steps: 1, costUsd: 0, exitCode: 0 }, state);
    expect(summary).not.toHaveProperty('unreportedFrames');
    expect(state).toEqual({ metricsSeen: true, metricsIncomplete: false });
  });

  it('marks one incomplete usage frame and preserves measured fields', () => {
    const summary = aiSummary();
    const state = parserState();
    applyAiExploreEvent(summary, 'metrics', { inputTokens: 12, outputTokens: 8, costUsd: 0.01 }, state);
    expect(summary.inputTokens).toBe(12);
    expect(summary.outputTokens).toBe(8);
    expect(summary.totalTokens).toBe(0);
    expect(summary.unreportedFrames).toBe(1);
    expect(state.metricsIncomplete).toBe(true);
  });

  it('marks the done-only zero-cost fallback as unreported', () => {
    const summary = aiSummary();
    const state = parserState();
    applyAiExploreEvent(summary, 'done', { costUsd: 0, exitCode: 1 }, state);
    expect(summary.costUsd).toBe(0);
    expect(summary.unreportedFrames).toBe(1);
    expect(state).toEqual({ metricsSeen: false, metricsIncomplete: true });
  });
});

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

describe('D-003 interaction quiet precondition', () => {
  const spec = (overrides: Partial<InteractionMeasureSpec>): InteractionMeasureSpec => ({
    name: 'test-interaction',
    ...overrides,
  });

  it('waits for the shared primitive after setup and before a selector click', () => {
    const script = buildInteractionMeasureScript(
      spec({ setup: 'document.body.dataset.ready = "1";', triggerSelector: '#trigger' }),
    );
    const quiet = script.indexOf('main thread did not reach the D-003 quiet precondition');
    const click = script.indexOf('trigger.click()');
    expect(quiet).toBeGreaterThan(-1);
    expect(click).toBeGreaterThan(quiet);
  });

  it('waits before setup when setup itself is the interaction trigger', () => {
    const script = buildInteractionMeasureScript(
      spec({ setup: 'history.pushState({}, "", "?palette=true");' }),
    );
    const quiet = script.indexOf('main thread did not reach the D-003 quiet precondition');
    const setup = script.indexOf('history.pushState({}, "", "?palette=true");');
    expect(quiet).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(quiet);
  });

  it('embeds the generic helper source rather than a second local rAF implementation', () => {
    const script = buildInteractionMeasureScript(spec({ setup: 'void 0;' }));
    expect(script).toContain('requestAnimationFrame');
    expect(script).toContain('consecutiveFrames');
    expect(script).toContain('timeoutMs');
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

describe('resolveTauriAgentToolsCommand', () => {
  it('uses the verifier-provided absolute executable when ambient PATH is irrelevant', () => {
    const candidate = '/opt/papercusp/bin/tauri-agent-tools';
    expect(resolveTauriAgentToolsCommand(
      { VERIFY_TAURI_AGENT_TOOLS_BIN: candidate },
      (value) => value === candidate,
    )).toBe(candidate);
  });

  it('falls back to PATH lookup when the override is absent, relative, or not executable', () => {
    expect(resolveTauriAgentToolsCommand({}, () => false)).toBe('tauri-agent-tools');
    expect(resolveTauriAgentToolsCommand(
      { VERIFY_TAURI_AGENT_TOOLS_BIN: 'relative/tauri-agent-tools' },
      () => true,
    )).toBe('tauri-agent-tools');
    expect(resolveTauriAgentToolsCommand(
      { VERIFY_TAURI_AGENT_TOOLS_BIN: '/missing/tauri-agent-tools' },
      () => false,
    )).toBe('tauri-agent-tools');
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

  // ---- frame attribution: setup cost is EXCLUDED but never INVISIBLE ----
  // The chaos suite failed a 200ms APP budget on the recorder's own arming
  // (a ~226KB dynamic import + a full-document tagging pass). Arming frames now
  // go in a separate bucket, and these pin that the exclusion stays auditable.

  it('reports WHERE the worst graded frame landed, so a breach can be attributed', () => {
    const res = grade({ maxFrameMs: 180, maxFrameAtMs: 2400 });
    expect(res.actual).toContain('@2400ms into window');
  });

  it('reports the excluded arming cost rather than dropping it', () => {
    // inpSamples>0 so the separate unmeasured-INP guard does not skip this and
    // mask what is being asserted: that a big ARMING frame is not an app breach.
    const res = grade({ inpSamples: 9, maxInp: 40, p95Inp: 32, maxFrameMs: 40, setupMaxFrameMs: 412, setupFrameDrops: 2 });
    expect(res.actual).toContain('setup maxFrame=412ms');
    expect(res.actual).toContain('drops=2');
    expect(res.actual).toContain('excluded from grade');
    // Excluded means excluded: a large ARMING frame must not fail the app budget.
    expect(res.status).toBe('pass');
    // …and must not enter the trend series as if it were an app frame.
    const frameMeasure = (res.measures ?? []).find((m) => m.key === 'chaos:x:max-frame');
    expect(frameMeasure?.value).toBe(40);
  });

  it('distinguishes a recorder that does not report arming cost from one reporting ZERO', () => {
    // undefined => the SPA bundle predates the split. Printing this as 0 would
    // assert "arming was free" on no evidence, which is the absent-vs-zero
    // conflation the whole guard exists to prevent.
    expect(grade({ setupMaxFrameMs: undefined }).actual).toContain('setup=unreported');
    expect(grade({ setupMaxFrameMs: 0, setupFrameDrops: 0 }).actual).toContain('setup maxFrame=0ms');
    expect(grade({ setupMaxFrameMs: 0 }).actual).not.toContain('unreported');
  });

  // Calibration: without this, an implementation that always excluded frames, or
  // always printed 'unreported', would satisfy every frame assertion above.
  it('still FAILS on a genuine in-window frame breach even when arming was clean', () => {
    const res = grade({ maxFrameMs: 512, maxFrameAtMs: 3100, setupMaxFrameMs: 12 });
    expect(res.status).toBe('fail');
    expect(res.actual).toContain('@3100ms into window');
    expect(res.actual).toContain('setup maxFrame=12ms');
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
