/**
 * P-016 gate fire drill — pure-module tests (gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * Every branch of runGateFireDrill in both directions, plus a calibration leg that runs the
 * REAL evaluateVerdictRateAlarm against a drill-shaped window — so the drill's central
 * assertion ("a killed fire with zero verdicts alarms") is proven against the genuine
 * evaluator, not a stub of it, and the counterfactual-gateRed design is pinned by a control
 * showing the real evaluator stays silent when gateRed is false.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runGateFireDrill,
  DRILL_RUN_UP_BUDGET_MS,
  type GateFireDrillDeps,
  type GateFireDrillState,
  type DrillOutcome,
} from './gate-fire-drill';
import { evaluateVerdictRateAlarm, type VerdictRateWindow } from './gate-verdict-rate-alarm';

const GREEN_IDLE: GateFireDrillState = {
  gateRed: false,
  consecutiveReds: 0,
  runInFlight: false,
  held: false,
  loadOk: true,
};

const DRILL_WINDOW: VerdictRateWindow = { fires: 1, verdicts: 0, lastVerdictBearingAtMs: null };

interface DepOverrides {
  state?: Partial<GateFireDrillState>;
  postState?: Partial<GateFireDrillState>;
  launch?: { launched: boolean; unit: string; reason?: string };
  up?: boolean;
  killed?: boolean;
  window?: VerdictRateWindow;
  evaluate?: GateFireDrillDeps['evaluate'];
}

function makeDeps(o: DepOverrides = {}) {
  let readCount = 0;
  const recorded: DrillOutcome[] = [];
  const alarmed: DrillOutcome[] = [];
  let t = 1_000_000;
  const deps: GateFireDrillDeps = {
    now: () => (t += 250),
    sleep: vi.fn(async () => {}),
    readGateState: vi.fn(async () => {
      readCount += 1;
      const base = { ...GREEN_IDLE, ...(o.state ?? {}) };
      return readCount === 1 ? base : { ...base, ...(o.postState ?? {}) };
    }),
    launchDrillRun: vi.fn(async () => o.launch ?? { launched: true, unit: 'papercusp-checkpoint.service' }),
    waitForRunUp: vi.fn(async () => o.up ?? true),
    killRun: vi.fn(async () => o.killed ?? true),
    readWindow: vi.fn(async () => o.window ?? DRILL_WINDOW),
    evaluate: o.evaluate ?? evaluateVerdictRateAlarm,
    suiteBudgetMs: () => 115 * 60_000,
    recordOutcome: vi.fn(async (out: DrillOutcome) => {
      recorded.push(out);
    }),
    alarmDetectorFailure: vi.fn(async (out: DrillOutcome) => {
      alarmed.push(out);
    }),
  };
  return { deps, recorded, alarmed };
}

describe('P-016 — gate fire drill skips (never fight the gate)', () => {
  it('skips on a RED gate without launching — a drill kill during an incident destroys a real verdict attempt', async () => {
    const { deps, recorded, alarmed } = makeDeps({ state: { gateRed: true, consecutiveReds: 7 } });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('skip-gate-red');
    expect(deps.launchDrillRun).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1); // every path records exactly one outcome row
    expect(alarmed).toHaveLength(0); // skips never page
  });

  it('skips while a run is in flight', async () => {
    const { deps } = makeDeps({ state: { runInFlight: true } });
    const out = await runGateFireDrill(deps);
    expect(out.reason).toBe('skip-run-in-flight');
    expect(deps.launchDrillRun).not.toHaveBeenCalled();
  });

  it('skips while a hold is placed (admission unknown counts as held — fail closed)', async () => {
    const { deps } = makeDeps({ state: { held: true } });
    const out = await runGateFireDrill(deps);
    expect(out.reason).toBe('skip-held');
  });

  it('skips under host load', async () => {
    const { deps } = makeDeps({ state: { loadOk: false } });
    const out = await runGateFireDrill(deps);
    expect(out.reason).toBe('skip-load');
  });

  it('treats a REFUSED launch as a skip, not a failure — the launcher guards were doing their job', async () => {
    const { deps, alarmed } = makeDeps({ launch: { launched: false, unit: 'u', reason: 'already_running' } });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('skipped');
    expect(out.reason).toBe('launch-refused');
    expect(out.detail).toContain('already_running');
    expect(deps.killRun).not.toHaveBeenCalled();
    expect(alarmed).toHaveLength(0);
  });
});

describe('P-016 — drill failures page as detector regressions', () => {
  it('FAILS when the accepted launch never becomes an observable unit', async () => {
    const { deps, alarmed } = makeDeps({ up: false });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('fail');
    expect(out.reason).toBe('run-never-up');
    expect(deps.waitForRunUp).toHaveBeenCalledWith(expect.any(String), DRILL_RUN_UP_BUDGET_MS);
    expect(alarmed).toHaveLength(1);
  });

  it('FAILS when the unit survives the stop — the kill lever itself is broken', async () => {
    const { deps, alarmed } = makeDeps({ killed: false });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('fail');
    expect(out.reason).toBe('kill-failed');
    expect(alarmed).toHaveLength(1);
  });

  it('FAILS when the P-001 fire anchor is missing from the drill window — killed runs invisible to the rate alarm', async () => {
    const { deps, alarmed } = makeDeps({ window: { fires: 0, verdicts: 0, lastVerdictBearingAtMs: null } });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('fail');
    expect(out.reason).toBe('anchor-missing');
    expect(alarmed).toHaveLength(1);
  });

  it('FAILS when a verdict-bearing row lands inside the drill window — the assertions are no longer about the killed run', async () => {
    const { deps } = makeDeps({ window: { fires: 2, verdicts: 1, lastVerdictBearingAtMs: 1 } });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('fail');
    expect(out.reason).toBe('unexpected-verdict');
  });

  it('FAILS when the evaluator does not alarm on a killed-fire window — the P-003 chain is blind', async () => {
    const { deps, alarmed } = makeDeps({
      evaluate: () => ({ alarmed: false, reason: null, detail: null }),
    });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('fail');
    expect(out.reason).toBe('alarm-did-not-fire');
    expect(alarmed).toHaveLength(1);
  });

  it('FAILS when consecutiveReds moved across the drill — a no-verdict kill must never count as a red (P-002)', async () => {
    const { deps } = makeDeps({ postState: { consecutiveReds: 1 } });
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('fail');
    expect(out.reason).toBe('gate-health-poisoned');
  });
});

describe('P-016 — the passing drill', () => {
  it('passes end-to-end through the REAL evaluator, records one outcome, pages nothing', async () => {
    const { deps, recorded, alarmed } = makeDeps();
    const out = await runGateFireDrill(deps);
    expect(out.status).toBe('pass');
    expect(out.reason).toBe('drill-pass');
    expect(out.alarm?.alarmed).toBe(true);
    expect(out.alarm?.reason).toBe('no-verdict-rate');
    expect(out.counterfactualGateRed).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(alarmed).toHaveLength(0);
  });

  it('feeds the evaluator gateRed:true + minFires:1 + the drill-bounded window (the counterfactual contract)', async () => {
    const evaluate = vi.fn(evaluateVerdictRateAlarm);
    const { deps } = makeDeps({ evaluate });
    await runGateFireDrill(deps);
    expect(evaluate).toHaveBeenCalledTimes(1);
    const input = evaluate.mock.calls[0]![0]!;
    expect(input.gateRed).toBe(true);
    expect(input.minFires).toBe(1);
    expect(input.window).toEqual(DRILL_WINDOW);
    expect(input.windowMs).toBeGreaterThan(0);
  });
});

describe('P-016 — calibration against the real P-003 evaluator', () => {
  it('the drill-shaped window (1 killed fire, 0 verdicts) alarms as no-verdict-rate', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: Date.now(),
      gateRed: true,
      window: DRILL_WINDOW,
      suiteBudgetMs: 115 * 60_000,
      minFires: 1,
      windowMs: 120_000,
    });
    expect(v.alarmed).toBe(true);
    expect(v.reason).toBe('no-verdict-rate');
  });

  it('CONTROL: the same window with gateRed:false does NOT alarm — which is exactly why the drill passes the counterfactual', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: Date.now(),
      gateRed: false,
      window: DRILL_WINDOW,
      suiteBudgetMs: 115 * 60_000,
      minFires: 1,
      windowMs: 120_000,
    });
    expect(v.alarmed).toBe(false);
  });

  it('CONTROL: a healthy window (1 fire, 1 verdict) does not alarm even red — the drill cannot false-pass on a survived run', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: Date.now(),
      gateRed: true,
      window: { fires: 1, verdicts: 1, lastVerdictBearingAtMs: Date.now() },
      suiteBudgetMs: 115 * 60_000,
      minFires: 1,
      windowMs: 120_000,
    });
    expect(v.alarmed).toBe(false);
  });
});
