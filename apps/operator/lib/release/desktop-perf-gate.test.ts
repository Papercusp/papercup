import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateDesktopPerfGate,
  desktopPerfGatePolicyFromFlags,
  runDesktopPerfGate,
  failingMeasures,
  breachedInvariants,
  missingBudgetedInteractions,
  DEFAULT_DESKTOP_PERF_MAX_AGE_MS,
  DEFAULT_QUIET_WINDOW,
  PSI_SOME_KEY_PREFIX,
  PSI_FULL_KEY_PREFIX,
  classifyRunPressure,
  readHostPressure,
  readBinaryBuiltAt,
  binaryPredatesBaseline,
  BUILD_SWEEP_LAG_TOLERANCE_MS,
  type DesktopPerfBaseline,
  type DesktopPerfGatePolicy,
} from './desktop-perf-gate';
import { DESKTOP_PERF_BINARY_BUILT_AT_KEY } from '@papercusp/operator-core/lib/admin-test-suites-shared';
import { DESKTOP_PERF_BUDGETS } from '@papercusp/operator-core/lib/system-health/desktop-perf-budgets';
import type { DesktopPerfRun, DesktopPerfMeasure } from '@papercusp/operator-core/lib/system-health/desktop-perf-runs';

// `createdTs` defaults to NOW because the gate now applies a freshness window: the
// previous fixture value of 1 (epoch+1ms, i.e. 1970) would make every run in this
// file STALE and route all of these cases into the fail-soft branch, quietly
// gutting the suite instead of failing it.
function run(
  measures: DesktopPerfMeasure[],
  status: DesktopPerfRun['status'] = 'pass',
  createdTs: number = Date.now(),
  options: { includeDeclaredInteractions?: boolean } = {},
): DesktopPerfRun {
  const includeDeclaredInteractions = options.includeDeclaredInteractions ?? measures.length > 0;
  const declaredInteractions: DesktopPerfMeasure[] = includeDeclaredInteractions
    ? Object.entries(DESKTOP_PERF_BUDGETS.interactions).map(([name, budget]) => ({
        key: `interaction:${name}`,
        value: 0,
        unit: 'ms',
        budget,
        ok: true,
      }))
    : [];
  return {
    id: 'r1',
    workspaceId: 'default',
    createdTs,
    source: 'admin-suite',
    status,
    gitSha: 'abc12345',
    buildSha: null,
    runId: 'testrun-1',
    measures: [...measures, ...declaredInteractions],
  };
}
const ok: DesktopPerfMeasure = { key: 'route:harness-warm', value: 900, unit: 'ms', budget: 1500, ok: true };
const breach: DesktopPerfMeasure = { key: 'interaction:plan-popup-open', value: 1800, unit: 'ms', budget: 1500, ok: false };
/** The P-003c invariant measures: egress held / egress escaped / detector absent. */
const egressClean: DesktopPerfMeasure = { key: 'invariant:webview-http-egress', value: 0, unit: 'count', budget: 0, ok: true, invariant: true };
const egressBreach: DesktopPerfMeasure = { key: 'invariant:webview-http-egress', value: 9, unit: 'count', budget: 0, ok: false, invariant: true };
/**
 * -1 is the spec's "detector absent" sentinel: the probe DID NOT RUN.
 *
 * WI-39665 D-008 changed what this means to the gate. It used to read as a BREACH, on the
 * reasoning that "unknown must never read as clean" — which is right, and is still
 * asserted below. But `block` is not the only way to avoid reading as clean, and it is the
 * one with a catastrophic blast radius: `desktop_perf_runs` has no harness scoping, and the
 * invariant branch bypasses BOTH block-mode arming and the PSI-quiet window, so one
 * unmeasured probe froze `main` for every harness in the workspace for hours on
 * 2026-08-17. The verdict is now `warn`/`unknown` — audible, never clean, never blocking.
 */
const egressUnknown: DesktopPerfMeasure = { key: 'invariant:webview-http-egress', value: -1, unit: 'count', budget: 0, ok: false, invariant: true };
/** An invariant carrying NO budget — breachedInvariants must still catch it. */
const unbudgetedInvariant: DesktopPerfMeasure = { key: 'invariant:console-errors', value: 3, unit: 'count', budget: null, ok: false, invariant: true };
/**
 * D-005 PSI stamps. `quiet()` is spread into a measure list to make a run a
 * LOAD-CONTROLLED sample; `contended()` makes it unmeasurable.
 *
 * Every pre-existing fixture in this file predates the stamp, so without a default
 * they would all be `unstamped` — which now routes a breach into the unmeasurable
 * branch. That would silently convert the block-mode cases below into warn-mode
 * cases and the suite would still pass while asserting nothing about arming, the
 * same shape as the createdTs/staleness trap noted above. So the cases that are
 * ABOUT a breach verdict stamp themselves quiet explicitly, and the `unstamped`
 * behaviour gets its own named tests rather than being the silent default.
 */
function quiet(some = 0.07, full = 0): DesktopPerfMeasure[] {
  return [
    { key: `${PSI_SOME_KEY_PREFIX}start`, value: some, unit: 'count', budget: null, ok: true },
    { key: `${PSI_SOME_KEY_PREFIX}end`, value: some, unit: 'count', budget: null, ok: true },
    { key: `${PSI_FULL_KEY_PREFIX}start`, value: full, unit: 'count', budget: null, ok: true },
    { key: `${PSI_FULL_KEY_PREFIX}end`, value: full, unit: 'count', budget: null, ok: true },
  ];
}
/** 2.15 is a REAL contended reading from the derivation sample (LCP 3246ms). */
function contended(some = 2.15): DesktopPerfMeasure[] {
  return quiet(some, 0);
}

const WARN_ONLY: DesktopPerfGatePolicy = { enabled: true, block: false, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS, quiet: DEFAULT_QUIET_WINDOW };
const ARMED: DesktopPerfGatePolicy = { enabled: true, block: true, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS, quiet: DEFAULT_QUIET_WINDOW };

describe('evaluateDesktopPerfGate (pure)', () => {
  it('disabled → pass, reads nothing', () => {
    const d = evaluateDesktopPerfGate(
      run([breach]),
      { enabled: false, block: false, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS, quiet: DEFAULT_QUIET_WINDOW },
      'deadbeefcafef00d',
    );
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.summary).toContain('disabled');
  });

  // D-007: a DEAD PRODUCER warns instead of passing silently. It still never blocks (that
  // is the fail-soft property, asserted below with block-mode ARMED) — what changed is that
  // it is now audible, because green-checkpoint only broadcasts a non-`pass` action.
  it('no run / no measures → warn (fail-soft unknown, never blocks)', () => {
    for (const r of [null, run([])]) {
      const d = evaluateDesktopPerfGate(r, ARMED, 'abc12345');
      expect(d.action).toBe('warn');
      expect(d.action).not.toBe('block');
      expect(d.verdictStatus).toBe('unknown');
      expect(d.reasons.join(' ')).toMatch(/nothing is producing/i);
      expect(d.summary).toContain('UNMEASURED');
    }
  });

  // Freshness window (WI-6538). Before this, `readLatestRun` returned the most
  // recent row at ANY age, so ONE run would be re-applied as the verdict for every
  // later candidate forever. That was invisible only because the table was empty.
  describe('freshness window', () => {
    const NOW = 1_800_000_000_000;
    const hoursAgo = (h: number) => NOW - h * 3_600_000;

    // D-007: stale is `warn` (audible) but still `unknown` — never a breach, never a block.
    it('a run older than the window → warn/unknown, never a breach', () => {
      const d = evaluateDesktopPerfGate(run([breach], 'fail', hoursAgo(30)), WARN_ONLY, 'abc123', NOW);
      expect(d.action).toBe('warn');
      expect(d.verdictStatus).toBe('unknown');
      expect(d.summary).toContain('STALE');
      expect(d.summary).toContain('30h old');
      // The breach is NOT reported as a reason — stale data is not a verdict.
      expect(d.reasons.join(' ')).not.toContain('plan-popup-open');
    });

    it('staleness outranks block-mode — an armed gate still will not block on old data', () => {
      const d = evaluateDesktopPerfGate(run([breach], 'fail', hoursAgo(72)), ARMED, 'abc123', NOW);
      expect(d.action).toBe('warn');
      expect(d.action).not.toBe('block');
      expect(d.verdictStatus).toBe('unknown');
    });

    // Stamped quiet so this isolates FRESHNESS: unstamped, the run would be judged
    // `unknown` by the D-005 pressure branch and this case would assert nothing about
    // the freshness window at all.
    it('a run INSIDE the window is still judged normally', () => {
      const d = evaluateDesktopPerfGate(run([breach, ...quiet()], 'fail', hoursAgo(2)), WARN_ONLY, 'abc123', NOW);
      expect(d.action).toBe('warn');
      expect(d.verdictStatus).toBe('crit');
    });

    // The distinction the whole window exists to preserve: an OLD run must not be
    // reported as a healthy pass, because "clean" and "nobody measured in days"
    // are opposite operational facts that a bare `pass` would conflate.
    it('a stale PASSING run is reported unknown, not ok', () => {
      const d = evaluateDesktopPerfGate(run([ok], 'pass', hoursAgo(48)), WARN_ONLY, 'abc123', NOW);
      expect(d.verdictStatus).toBe('unknown');
      expect(d.summary).toContain('STALE');
    });

    it('maxAgeMs of 0 disables the window rather than staling everything', () => {
      const policy: DesktopPerfGatePolicy = { enabled: true, block: false, maxAgeMs: 0, quiet: DEFAULT_QUIET_WINDOW };
      const d = evaluateDesktopPerfGate(run([breach, ...quiet()], 'fail', hoursAgo(9000)), policy, 'abc123', NOW);
      expect(d.verdictStatus).toBe('crit');
    });
  });

  it('all budgeted measures met → pass (ok)', () => {
    const d = evaluateDesktopPerfGate(run([ok]), WARN_ONLY);
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('ok');
  });

  it('a QUIET-WINDOW budgeted breach → warn when block-mode not armed, crit verdict + reasons', () => {
    const d = evaluateDesktopPerfGate(run([ok, breach, ...quiet()]), WARN_ONLY, 'deadbeefcafef00d');
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('crit');
    expect(d.reasons).toEqual(['interaction:plan-popup-open 1800ms > budget 1500ms']);
    expect(d.summary).toContain('deadbeef');
    expect(d.summary).toContain('block-mode not armed');
  });

  it('a QUIET-WINDOW budgeted breach → block when block-mode is armed', () => {
    const d = evaluateDesktopPerfGate(run([breach, ...quiet()]), ARMED);
    expect(d.action).toBe('block');
    expect(d.verdictStatus).toBe('crit');
    expect(d.pressure).toBe('quiet');
    expect(d.summary).toContain('BLOCKED');
    // The summary must SAY the host was quiet: an armed block that cannot name its
    // own measurement conditions is the false-red D-003 refused, just louder.
    expect(d.summary).toContain('QUIET host');
  });

  it('an UNBUDGETED failing measure is not a regression → pass', () => {
    const unbudgeted: DesktopPerfMeasure = { key: 'x', value: 999, unit: 'ms', budget: null, ok: false };
    expect(evaluateDesktopPerfGate(run([unbudgeted]), ARMED).action).toBe('pass');
    expect(failingMeasures(run([unbudgeted]))).toEqual([]);
  });

  it('a warned run with no budgeted breach → warn (never block, even armed)', () => {
    const d = evaluateDesktopPerfGate(run([ok], 'warn'), ARMED);
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('warn');
  });

  it('a fresh run missing a declared interaction → warn/unknown, never pass', () => {
    const incomplete = run([ok], 'pass', Date.now(), { includeDeclaredInteractions: false });
    expect(missingBudgetedInteractions(incomplete)).toEqual(Object.keys(DESKTOP_PERF_BUDGETS.interactions));

    const d = evaluateDesktopPerfGate(incomplete, ARMED);
    expect(d.action).toBe('warn');
    expect(d.action).not.toBe('pass');
    expect(d.action).not.toBe('block');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.reasons.join(' ')).toContain('interaction:learning-view-switch');
    expect(d.summary).toContain('INCOMPLETE');
    expect(d.summary).toContain('learning-view-switch');
  });

  it('formats kb (RSS) and count budgets in the reason', () => {
    const rss: DesktopPerfMeasure = { key: 'memory:rss-kb', value: 4_194_304, unit: 'kb', budget: 3_670_016, ok: false };
    const drops: DesktopPerfMeasure = { key: 'chaos:frame-drops', value: 12, unit: 'count', budget: 8, ok: false };
    const d = evaluateDesktopPerfGate(run([rss, drops, ...quiet()]), WARN_ONLY);
    expect(d.reasons).toEqual(['memory:rss-kb 4096MB > budget 3584MB', 'chaos:frame-drops 12 > budget 8']);
  });
});

describe('desktopPerfGatePolicyFromFlags', () => {
  const REST = { maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS, quiet: DEFAULT_QUIET_WINDOW };
  const on = async () => true;
  const off = async () => false;

  it('enabled and block each track their OWN flag (D-005 armed block-mode)', async () => {
    expect(await desktopPerfGatePolicyFromFlags(on, on)).toEqual({ enabled: true, block: true, ...REST });
    expect(await desktopPerfGatePolicyFromFlags(on, off)).toEqual({ enabled: true, block: false, ...REST });
    expect(await desktopPerfGatePolicyFromFlags(off, on)).toEqual({ enabled: false, block: true, ...REST });
  });

  it('either flag-read error fails safe — never invents a deploy-holding verdict', async () => {
    const boom = async () => { throw new Error('boom'); };
    expect(await desktopPerfGatePolicyFromFlags(boom, on)).toMatchObject({ enabled: false });
    // The important direction: an unreadable BLOCK flag must leave the gate warn-only
    // rather than defaulting to armed, or a flag-store hiccup starts holding deploys.
    expect(await desktopPerfGatePolicyFromFlags(on, boom)).toMatchObject({ enabled: true, block: false });
  });

  it('ships a freshness window by default — an unbounded gate re-asserts old runs forever', async () => {
    const policy = await desktopPerfGatePolicyFromFlags(on, on);
    expect(policy.maxAgeMs).toBeGreaterThan(0);
  });

  it('ships the derived quiet window, not an unbounded one', async () => {
    const policy = await desktopPerfGatePolicyFromFlags(on, on);
    expect(policy.quiet.someAvg10Max).toBeGreaterThan(0);
    expect(Number.isFinite(policy.quiet.someAvg10Max)).toBe(true);
    expect(policy.quiet.fullAvg10Max).toBe(0);
  });
});

describe('runDesktopPerfGate', () => {
  it('disabled → pass without reading a run', async () => {
    let read = 0;
    // maxAgeMs is required since the freshness window landed; this call site was
    // missed then and had been a standing TS2345 in the apps/operator baseline.
    const d = await runDesktopPerfGate({ enabled: false, block: false, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS, quiet: DEFAULT_QUIET_WINDOW }, {
      io: { readLatestRun: async () => { read += 1; return run([breach]); } },
    });
    expect(d.action).toBe('pass');
    expect(read).toBe(0);
  });

  it('enabled + a regressed latest run measured quiet → warn', async () => {
    const d = await runDesktopPerfGate(WARN_ONLY, {
      workspaceId: 'default', candidateSha: 'feedface0000',
      io: { readLatestRun: async () => run([breach, ...quiet()]) },
    });
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('crit');
  });

  it('a read error degrades to unknown → warn, never blocks (fail-soft)', async () => {
    const d = await runDesktopPerfGate(ARMED, {
      io: { readLatestRun: async () => { throw new Error('pg down'); } },
    });
    expect(d.action).toBe('warn');
    expect(d.action).not.toBe('block');
    expect(d.verdictStatus).toBe('unknown');
  });

  it('baselineRef threads the baseline time into the stale-build branch (WI-10003815)', async () => {
    const calls: Array<[string, string]> = [];
    const builtAt = Date.now() - 12 * 86_400_000;
    const d = await runDesktopPerfGate(ARMED, {
      candidateSha: 'd425508f01ed', baselineRef: 'main', repoRoot: '/repo',
      io: {
        readLatestRun: async () => run([breach, ...quiet(), builtStamp(builtAt)]),
        readNewestCommitAtMs: async (ref, root) => { calls.push([ref, root]); return Date.now() - 3_600_000; },
      },
    });
    expect(calls).toEqual([['main', '/repo']]);
    expect(d.action).toBe('warn');
    expect(d.reasons[0]).toMatch(/UNATTRIBUTABLE \(stale build\)/);
  });

  it('an unreadable baseline makes no attribution call — the breach still blocks', async () => {
    const d = await runDesktopPerfGate(ARMED, {
      baselineRef: 'main',
      io: {
        readLatestRun: async () => run([breach, ...quiet(), builtStamp(Date.now() - 12 * 86_400_000)]),
        readNewestCommitAtMs: async () => { throw new Error('git failed'); },
      },
    });
    expect(d.action).toBe('block');
  });

  it('no baselineRef → the baseline is never read (callers opt in)', async () => {
    let reads = 0;
    const d = await runDesktopPerfGate(ARMED, {
      io: {
        readLatestRun: async () => run([breach, ...quiet(), builtStamp(Date.now() - 12 * 86_400_000)]),
        readNewestCommitAtMs: async () => { reads += 1; return Date.now(); },
      },
    });
    expect(reads).toBe(0);
    expect(d.action).toBe('block');
  });
});

/** The WDIO runner's `build:` stamp — when the measured packaged binary was built. */
function builtStamp(builtAtMs: number): DesktopPerfMeasure {
  return { key: DESKTOP_PERF_BINARY_BUILT_AT_KEY, value: builtAtMs, unit: 'count', budget: null, ok: true };
}

/**
 * WI-10003815 — a fresh RUN of a stale BUILD. Observed 2026-09-29: a quiet-host
 * plan-popup-open breach (1540ms > 1500) measured on a 12-day-old packaged binary
 * held suite-green repairHead d425508f. A build older than the green pin can only
 * show what is already on it, so the gate must not charge the candidate with it.
 */
describe('stale packaged build (WI-10003815)', () => {
  const NOW = 1_790_650_000_000;
  const DAY = 86_400_000;
  const MAIN: DesktopPerfBaseline = { ref: 'main', newestCommitAtMs: NOW - 5 * 3_600_000 };
  const staleBuild = builtStamp(NOW - 12 * DAY);

  it('the observed case: quiet breach on a 12-day-old build → warn, reported as pre-existing, never block', () => {
    const d = evaluateDesktopPerfGate(run([breach, ...quiet(), staleBuild], 'fail', NOW), ARMED, 'd425508f01ed', NOW, MAIN);
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.pressure).toBe('quiet');
    expect(d.reasons[0]).toMatch(/UNATTRIBUTABLE \(stale build\).*cannot contain d425508f/);
    // The finding is not swallowed: it stays audible, charged to main rather than the candidate.
    expect(d.reasons).toContain('pre-existing on main: interaction:plan-popup-open 1800ms > budget 1500ms');
    expect(d.summary).toMatch(/STALE BUILD, NOT reported as d425508f's regression/);
    expect(d.summary).toContain('11.8d before');
  });

  it('CONTROL: the same breach on a build newer than main still blocks', () => {
    const fresh = builtStamp(MAIN.newestCommitAtMs! + 60_000);
    const d = evaluateDesktopPerfGate(run([breach, ...quiet(), fresh], 'fail', NOW), ARMED, 'd425508f01ed', NOW, MAIN);
    expect(d.action).toBe('block');
    expect(d.verdictStatus).toBe('crit');
  });

  it('an invariant breach on a stale build warns too — it is already on main', () => {
    const d = evaluateDesktopPerfGate(run([egressBreach, staleBuild], 'fail', NOW), ARMED, 'abc12345', NOW, MAIN);
    expect(d.action).toBe('warn');
    expect(d.reasons.some((r) => r.startsWith('pre-existing on main: invariant:webview-http-egress'))).toBe(true);
  });

  it('a clean run on a stale build is not a clear: warn, UNMEASURED', () => {
    const d = evaluateDesktopPerfGate(run([ok, ...quiet(), staleBuild], 'pass', NOW), ARMED, 'abc12345', NOW, MAIN);
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.summary).toContain('abc12345 advances UNMEASURED');
  });

  it('within the sweep-lag tolerance the build may contain the pin → the breach still blocks', () => {
    const nearly = builtStamp(MAIN.newestCommitAtMs! - BUILD_SWEEP_LAG_TOLERANCE_MS + 60_000);
    const d = evaluateDesktopPerfGate(run([breach, ...quiet(), nearly], 'fail', NOW), ARMED, 'abc12345', NOW, MAIN);
    expect(d.action).toBe('block');
  });

  it('only a positive proof demotes: unstamped run, unknown baseline, or no baseline keep the old verdict', () => {
    const cases: Array<[DesktopPerfMeasure[], DesktopPerfBaseline | null | undefined]> = [
      [[breach, ...quiet()], MAIN],
      [[breach, ...quiet(), staleBuild], { ref: 'main', newestCommitAtMs: null }],
      [[breach, ...quiet(), staleBuild], undefined],
    ];
    for (const [measures, baseline] of cases) {
      expect(evaluateDesktopPerfGate(run(measures, 'fail', NOW), ARMED, 'abc12345', NOW, baseline).action).toBe('block');
    }
  });

  it('a stale RUN still reports as a stale run, not a stale build (branch order)', () => {
    const d = evaluateDesktopPerfGate(run([breach, ...quiet(), staleBuild], 'fail', NOW - 2 * DAY), ARMED, 'abc12345', NOW, MAIN);
    expect(d.summary).toMatch(/latest desktop-perf run is STALE/);
  });

  it('readBinaryBuiltAt ignores a non-positive stamp', () => {
    expect(readBinaryBuiltAt(run([builtStamp(0)], 'pass', NOW))).toBeNull();
    expect(readBinaryBuiltAt(run([staleBuild], 'pass', NOW))).toBe(NOW - 12 * DAY);
  });

  // The producer side lives in tools/perf-test/wdio. Its own node-test now runs at the gate
  // too (WI-10003821), but only when that package changes; pin the cross-package contract from
  // HERE as well, so a change on THIS side is checked against it. If the runner stops stamping
  // (or stamps a drifted key) every run reads as unstamped and this branch goes silently
  // inert — the run keeps blocking candidates on stale builds.
  it('the WDIO producer stamps the binary with the key this gate reads', () => {
    const wdio = (f: string) => readFileSync(new URL(`../../../../tools/perf-test/wdio/${f}`, import.meta.url), 'utf8');
    expect(wdio('perf-report.ts')).toContain(`BINARY_BUILT_AT_KEY = "${DESKTOP_PERF_BINARY_BUILT_AT_KEY}"`);
    const conf = wdio('wdio.conf.ts');
    const onPrepare = conf.slice(conf.indexOf('async onPrepare()'), conf.indexOf('async onComplete()'));
    const stamp = onPrepare.indexOf('recordBinaryIdentity(TAURI_APP_PATH);');
    expect(stamp).toBeGreaterThan(onPrepare.indexOf('resetMeasures();'));
    expect(onPrepare.indexOf('resetMeasures();')).toBeGreaterThanOrEqual(0);
  });

  it('binaryPredatesBaseline is the single predicate the branch uses', () => {
    expect(binaryPredatesBaseline(run([staleBuild], 'pass', NOW), MAIN)).toEqual({
      builtAt: NOW - 12 * DAY,
      baselineAt: MAIN.newestCommitAtMs,
    });
    expect(binaryPredatesBaseline(run([], 'pass', NOW), MAIN)).toBeNull();
  });
});

/**
 * no-http-anywhere-2026-07-28 P-003c — invariants block, budgets warn.
 *
 * The whole point of the class is that it does NOT inherit the warn-until-armed
 * posture, so the load-bearing case is the FIRST one: warn-only policy, blocked
 * anyway. If that ever regresses to `warn`, the egress invariant silently stops
 * gating deploys while still looking wired up.
 */
describe('invariant measures (P-003c)', () => {
  it('breachedInvariants picks out only breached invariants', () => {
    expect(breachedInvariants(run([ok, breach, egressClean]))).toEqual([]);
    expect(breachedInvariants(run([ok, egressBreach])).map((m) => m.key)).toEqual(['invariant:webview-http-egress']);
    // Budget-less invariants count — failingMeasures would miss this one entirely.
    expect(breachedInvariants(run([unbudgetedInvariant]))).toHaveLength(1);
    expect(failingMeasures(run([unbudgetedInvariant]))).toHaveLength(0);
  });

  it('BLOCKS under a warn-only policy — an invariant does not wait for block-mode', () => {
    const d = evaluateDesktopPerfGate(run([ok, egressBreach]), WARN_ONLY, 'deadbeefcafef00d');
    expect(d.action).toBe('block');
    expect(d.verdictStatus).toBe('crit');
    expect(d.summary).toContain('INVARIANT BREACHED');
    expect(d.reasons.join()).toContain('invariant:webview-http-egress');
  });

  it('blocks under an armed policy too', () => {
    expect(evaluateDesktopPerfGate(run([egressBreach]), ARMED).action).toBe('block');
  });

  it('a held invariant does not block', () => {
    const d = evaluateDesktopPerfGate(run([ok, egressClean]), WARN_ONLY);
    expect(d.action).toBe('pass');
    expect(d.verdictStatus).toBe('ok');
  });

  // WI-39665 D-008. These four cases pin the whole shape of the unmeasured-invariant
  // verdict. Read them together: the property is "never clean, never blocking, and never
  // able to mask something that WAS measured", and no single assertion states it.
  it('an absent detector (-1 sentinel) does NOT block — a probe that never ran is not a breach', () => {
    const d = evaluateDesktopPerfGate(run([ok, egressUnknown]), WARN_ONLY);
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.summary).toContain('invariant:webview-http-egress');
    expect(d.summary).toContain('UNMEASURED');
  });

  // The ORIGINAL intent of this case, preserved verbatim as an assertion because it is the
  // half a future reader is most likely to undo: the fix must not have turned -1 into a
  // clear. `pass` is what green-checkpoint says NOTHING about (it only logs/broadcasts a
  // non-pass), so a silent detector degrading to `pass` is the fail-open D-007 exists to end.
  it('an absent detector never reads as CLEAN — the -1 sentinel must not degrade to pass', () => {
    const d = evaluateDesktopPerfGate(run([ok, egressUnknown]), WARN_ONLY);
    expect(d.action).not.toBe('pass');
    expect(d.verdictStatus).not.toBe('ok');
  });

  // THE RELOCATION TRAP. -1 carries budget 0 (non-null) with ok:false, so excluding it from
  // breachedInvariants alone would simply move the false block into the BUDGET branch —
  // which, armed and on a quiet host, blocks just the same. Same defect, new address.
  it('an absent detector does not block via the BUDGET branch either, even armed on a quiet host', () => {
    const d = evaluateDesktopPerfGate(run([ok, egressUnknown, ...quiet()]), ARMED);
    expect(d.action).toBe('warn');
    expect(d.verdictStatus).toBe('unknown');
  });

  // CALIBRATION CONTROL. Without this, every assertion above would also pass if the gate
  // had simply stopped evaluating invariants at all — the guard would look strong while
  // enforcing nothing. A real reading (value > 0) must still block, unarmed.
  it('a MEASURED breach still blocks — the fix must not have disabled invariant enforcement', () => {
    const d = evaluateDesktopPerfGate(run([ok, egressBreach]), WARN_ONLY);
    expect(d.action).toBe('block');
    expect(d.summary).toContain('INVARIANT BREACHED');
  });

  // The unmeasured branch sits AFTER the measured branches so it can never mask a verdict
  // that WAS taken: a real budget regression on a quiet armed host still wins.
  it('an unmeasured invariant does not mask a real budget breach in the same run', () => {
    const d = evaluateDesktopPerfGate(run([breach, egressUnknown, ...quiet()]), ARMED);
    expect(d.action).toBe('block');
    expect(d.summary).toContain('REGRESSED');
  });

  it('an invariant breach outranks a budget breach in the summary', () => {
    const d = evaluateDesktopPerfGate(run([breach, egressBreach]), WARN_ONLY);
    expect(d.action).toBe('block');
    expect(d.summary).toContain('INVARIANT BREACHED');
    // The budget regression must not be what gets reported as the headline.
    expect(d.summary).not.toContain('REGRESSED');
  });

  it('a STALE run does not block, even on a breached invariant', () => {
    const stale = run([egressBreach], 'fail', Date.now() - (DEFAULT_DESKTOP_PERF_MAX_AGE_MS + 60_000));
    const d = evaluateDesktopPerfGate(stale, WARN_ONLY, 'deadbeefcafef00d');
    // D-007: audible (warn) but still never a block, even for an invariant — a breach
    // recorded against a tree that no longer exists must not hold today's candidate.
    expect(d.action).toBe('warn');
    expect(d.action).not.toBe('block');
    expect(d.verdictStatus).toBe('unknown');
    expect(d.summary).toContain('STALE');
  });

  it('a disabled gate does not block on an invariant', () => {
    const d = evaluateDesktopPerfGate(run([egressBreach]), { enabled: false, block: false, maxAgeMs: DEFAULT_DESKTOP_PERF_MAX_AGE_MS, quiet: DEFAULT_QUIET_WINDOW });
    expect(d.action).toBe('pass');
  });

  it('a measure without the flag is never treated as an invariant', () => {
    // Same failing shape, no `invariant` — must take the warn path, not block.
    const lookalike: DesktopPerfMeasure = { key: 'invariant:webview-http-egress', value: 9, unit: 'count', budget: 0, ok: false };
    expect(evaluateDesktopPerfGate(run([lookalike]), WARN_ONLY).action).toBe('warn');
  });
});

/**
 * resource-efficiency-closeout-2026-08-13 D-005 — QUIET-GATED BLOCKING.
 *
 * The property under test is that the SAMPLE is gated, not the verdict: block-mode
 * may hold a deploy only for a breach the gate can attribute to an uncontended host.
 * Anything else is `unmeasurable` — warn + `unknown`, never `crit`.
 *
 * CALIBRATION FIRST. Every negative case here asserts "does not block", which is
 * also what a gate with block-mode accidentally disabled would produce — so the
 * whole block would pass vacuously if arming were broken. The calibration case
 * pins the positive direction with the SAME policy the negatives use, and the
 * DISCRIMINATION pairs then vary exactly one field from it.
 */
describe('D-005 quiet-window gating', () => {
  describe('classifyRunPressure (pure)', () => {
    it('reads the stamps a run carries', () => {
      const p = readHostPressure(run([...quiet(0.42), ok]));
      expect(p).toEqual({ someStart: 0.42, someEnd: 0.42, fullStart: 0, fullEnd: 0 });
    });

    it('quiet / contended / unstamped are three distinct answers', () => {
      expect(classifyRunPressure(run([...quiet(0.07), ok]))).toBe('quiet');
      expect(classifyRunPressure(run([...contended(2.15), ok]))).toBe('contended');
      expect(classifyRunPressure(run([ok]))).toBe('unstamped');
    });

    it('the threshold is a boundary, and it INCLUDES its own value', () => {
      const T = DEFAULT_QUIET_WINDOW.someAvg10Max;
      expect(classifyRunPressure(run(quiet(T)))).toBe('quiet');
      expect(classifyRunPressure(run(quiet(T + 0.01)))).toBe('contended');
    });

    it('EITHER phase above the window is enough — a run that got busy mid-flight is not quiet', () => {
      const start = quiet(0.01);
      // Overwrite only the END stamp: the box got busy while the run was measuring.
      const gotBusy = start.map((m) => (m.key === `${PSI_SOME_KEY_PREFIX}end` ? { ...m, value: 2.0 } : m));
      expect(classifyRunPressure(run(gotBusy))).toBe('contended');
      // ...and the mirror image, so this is not passing on start alone.
      const wasBusy = start.map((m) => (m.key === `${PSI_SOME_KEY_PREFIX}start` ? { ...m, value: 2.0 } : m));
      expect(classifyRunPressure(run(wasBusy))).toBe('contended');
    });

    it('a HALF-stamped run is unstamped, not half-trusted', () => {
      const onlyStart = quiet().filter((m) => !m.key.endsWith(':end'));
      expect(classifyRunPressure(run(onlyStart))).toBe('unstamped');
    });

    it('non-zero `full` pressure alone disqualifies a run whose `some` is quiet', () => {
      expect(classifyRunPressure(run(quiet(0.01, 0.5)))).toBe('contended');
    });

    it('absent `full` stamps do not disqualify a quiet run (kernels vary)', () => {
      const noFull = quiet(0.01).filter((m) => !m.key.startsWith(PSI_FULL_KEY_PREFIX));
      expect(classifyRunPressure(run(noFull))).toBe('quiet');
    });
  });

  describe('the gate decision', () => {
    // ── CALIBRATION: arming demonstrably WORKS under this exact policy ──
    it('CALIBRATION — an armed gate DOES block a quiet-window breach', () => {
      const d = evaluateDesktopPerfGate(run([breach, ...quiet()], 'fail'), ARMED, 'abc12345');
      expect(d.action).toBe('block');
      expect(d.verdictStatus).toBe('crit');
      expect(d.pressure).toBe('quiet');
    });

    // ── DISCRIMINATION: one field changes, the verdict changes ──
    it('the SAME breach measured under contention is UNMEASURABLE — warn, and NOT a regression', () => {
      const d = evaluateDesktopPerfGate(run([breach, ...contended()], 'fail'), ARMED, 'abc12345');
      expect(d.action).toBe('warn');
      // `unknown`, not `crit`: we do not know whether this candidate regressed.
      expect(d.verdictStatus).toBe('unknown');
      expect(d.pressure).toBe('contended');
      expect(d.summary).toContain('UNMEASURABLE');
      expect(d.summary).toContain('NOT reported as a regression');
      // The breach itself is still reported — suppressed as a verdict, not hidden.
      expect(d.reasons.join(' ')).toContain('interaction:plan-popup-open');
      expect(d.reasons[0]).toContain('UNMEASURABLE');
      // The actual numbers must be in the summary; "it was busy" without them is
      // unfalsifiable by whoever reads the broadcast.
      expect(d.summary).toContain('2.15');
    });

    it('an UNSTAMPED breach is unmeasurable too — no evidence of quiet is not evidence of quiet', () => {
      const d = evaluateDesktopPerfGate(run([breach], 'fail'), ARMED, 'abc12345');
      expect(d.action).toBe('warn');
      expect(d.verdictStatus).toBe('unknown');
      expect(d.pressure).toBe('unstamped');
      expect(d.summary).toContain('no /proc/pressure/cpu stamp');
    });

    it('suppression is a WARN, never a silent pass — the inert-gate failure mode', () => {
      // This is the whole reason the unmeasurable branch does not `pass`: 13 days of
      // fail-soft passes were indistinguishable from a healthy gate.
      for (const measures of [[breach, ...contended()], [breach]]) {
        const d = evaluateDesktopPerfGate(run(measures, 'fail'), ARMED);
        expect(d.action).not.toBe('pass');
        expect(d.action).toBe('warn');
      }
    });

    it('an INVARIANT breach still blocks under contention — load cannot make one false', () => {
      const d = evaluateDesktopPerfGate(run([egressBreach, ...contended()], 'fail'), WARN_ONLY, 'abc12345');
      expect(d.action).toBe('block');
      expect(d.verdictStatus).toBe('crit');
      expect(d.pressure).toBe('contended');
      expect(d.summary).toContain('INVARIANT BREACHED');
    });

    it('a PASS is honoured under contention, but is not reported as a load-controlled clear', () => {
      const contendedPass = evaluateDesktopPerfGate(run([ok, ...contended()]), ARMED);
      expect(contendedPass.action).toBe('pass');
      expect(contendedPass.verdictStatus).toBe('ok');
      expect(contendedPass.pressure).toBe('contended');
      expect(contendedPass.summary).toContain('contended sample');
      const quietPass = evaluateDesktopPerfGate(run([ok, ...quiet()]), ARMED);
      expect(quietPass.summary).toContain('quiet host');
      // Same action, DIFFERENT report — that difference is the only honesty available
      // when the sample cannot be vouched for in either direction.
      expect(quietPass.action).toBe(contendedPass.action);
      expect(quietPass.summary).not.toBe(contendedPass.summary);
    });

    it('a widened quiet window admits a formerly-contended run — the threshold is policy, not a constant', () => {
      const loose: DesktopPerfGatePolicy = { ...ARMED, quiet: { someAvg10Max: 5, fullAvg10Max: 0 } };
      const d = evaluateDesktopPerfGate(run([breach, ...contended(2.15)], 'fail'), loose);
      expect(d.pressure).toBe('quiet');
      expect(d.action).toBe('block');
    });

    it('pressure is reported on every decision that read a run, and null when none was read', () => {
      expect(evaluateDesktopPerfGate(null, ARMED).pressure).toBeNull();
      expect(evaluateDesktopPerfGate(run([ok]), { ...ARMED, enabled: false }).pressure).toBeNull();
      // A run existed ⇒ never null, so "quiet" is always distinguishable from "cannot say".
      expect(evaluateDesktopPerfGate(run([ok, ...quiet()]), ARMED).pressure).toBe('quiet');
      expect(evaluateDesktopPerfGate(run([ok], 'warn'), ARMED).pressure).toBe('unstamped');
    });

    it('staleness still outranks the quiet window — an old quiet run is not a verdict', () => {
      const NOW = 1_800_000_000_000;
      const d = evaluateDesktopPerfGate(run([breach, ...quiet()], 'fail', NOW - 30 * 3_600_000), ARMED, 'abc123', NOW);
      expect(d.action).toBe('warn');
      expect(d.action).not.toBe('block');
      expect(d.summary).toContain('STALE');
      expect(d.pressure).toBe('quiet');
    });
  });

  /**
   * The threshold is DERIVED (see DEFAULT_QUIET_WINDOW), so it is pinned here against
   * the sample it came from. If someone retunes it, these fail and force them to
   * re-derive rather than nudge a number that a release gate now depends on.
   */
  describe('the derived threshold vs its own sample', () => {
    // n=15, 2026-08-16T02:08–02:15Z, [max(PSI some avg10 start,end), LCP ms].
    const SAMPLE: Array<[number, number]> = [
      [0.0, 2583], [0.0, 2585], [0.0, 2640], [0.01, 2206], [0.07, 2721], [0.07, 2665],
      [0.18, 2765], [0.27, 2675], [0.63, 2817], [1.27, 2916], [1.82, 2695], [1.88, 2233],
      [2.0, 3085], [2.15, 3246], [3.26, 1311],
    ];
    const T = DEFAULT_QUIET_WINDOW.someAvg10Max;
    const LCP_BUDGET = 4000;

    it('admits a usable share of real runs — a window nothing passes is an inert gate', () => {
      const admitted = SAMPLE.filter(([psi]) => psi <= T);
      expect(admitted.length).toBeGreaterThanOrEqual(SAMPLE.length / 2);
    });

    it('the admitted band leaves real headroom to the budget, which is what makes blocking safe', () => {
      const admitted = SAMPLE.filter(([psi]) => psi <= T).map(([, lcp]) => lcp);
      const worst = Math.max(...admitted);
      const spread = worst - Math.min(...admitted);
      // A breach inside the window must be a move far larger than the measurement's
      // own variation, or an armed block is just noise with consequences.
      expect(LCP_BUDGET - worst).toBeGreaterThan(spread);
    });

    it('every reading worse than the admitted band falls OUTSIDE the window', () => {
      const worstAdmitted = Math.max(...SAMPLE.filter(([psi]) => psi <= T).map(([, lcp]) => lcp));
      for (const [psi, lcp] of SAMPLE) if (lcp > worstAdmitted) expect(psi).toBeGreaterThan(T);
    });

    it('a contended sample can read FALSELY FAST — why a contended pass is not a clear', () => {
      // The most contended run in the sample reported the FASTEST LCP of all 15.
      // LCP is a largest-element-so-far metric, so contention that stops the big
      // element painting leaves a smaller earlier one holding the title. This is the
      // measured refutation of "contention can only slow things down".
      const [worstPsi, itsLcp] = SAMPLE.reduce((a, b) => (b[0] > a[0] ? b : a));
      const quietBest = Math.min(...SAMPLE.filter(([psi]) => psi <= T).map(([, lcp]) => lcp));
      expect(worstPsi).toBeGreaterThan(T);
      expect(itsLcp).toBeLessThan(quietBest);
    });
  });
});
