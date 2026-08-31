/**
 * EI-19294826146331487 — the in-process sweeps now have a real on/off switch.
 *
 * What these tests hold down, in order of how much they would cost to get wrong:
 *
 *  1. FAIL-OPEN. A database that cannot answer must leave every sweep ARMED. The opposite
 *     reading ("no answer ⇒ disabled") would silently stop system-health and the stale-claim
 *     sweeps fleet-wide the first time PG hiccuped, and would look exactly like an owner's
 *     deliberate pause. Two negative controls below implement that wrong rule on purpose and
 *     assert this suite catches it.
 *  2. The switch is a SWITCH, not a one-way valve — a sweep turned off actually stops ticking,
 *     and turning it back on resumes it in the SAME process, without a host restart.
 *  3. A reconcile only ever touches sweeps this process is eligible to run, so a host-scoped
 *     sweep left to the cluster primary is never started here by a reconcile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IN_PROCESS_SWEEP_TARGET_ROLE,
  planSweepReconcile,
  reconcileSweepArmStateOnce,
  SWEEP_ARM_RECONCILER_NAME,
  type SweepArmReconcilerDeps,
  type SweepReconcilePlan,
} from './in-process-sweep-arm';
import {
  applyInProcessSweepArmState,
  armInProcessPeriodicChecks,
  disarmInProcessPeriodicChecks,
  inProcessPeriodicArmedNames,
  inProcessPeriodicEligibleChecks,
  type PeriodicCheck,
} from './in-process-periodic';
import { TARGET_ROLE_SPEND, routineControl } from '../automation/routine-classification';

afterEach(() => {
  disarmInProcessPeriodicChecks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const check = (name: string, intervalMs = 1000, tick = async () => {}): PeriodicCheck => ({
  name,
  intervalMs,
  classification: 'must-sample',
  tick,
});

// ── Negative controls: the two wrong rules, kept permanently ──────────────────
// Neither mutates production code. Each is a deliberately-wrong planner that the same
// assertions are run against, so "the tests pass" cannot mean "the tests are asleep".

/** WRONG RULE A: absence of an explicit enable is read as disabled (fail-CLOSED). */
function planFailClosed(input: {
  eligible: readonly string[];
  armed: readonly string[];
  disabled: ReadonlySet<string>;
  enabled?: ReadonlySet<string>;
}): SweepReconcilePlan {
  const armed = new Set(input.armed);
  const toStop: string[] = [];
  const toStart: string[] = [];
  for (const name of input.eligible) {
    const shouldRun = (input.enabled ?? new Set<string>()).has(name);
    if (shouldRun && !armed.has(name)) toStart.push(name);
    else if (!shouldRun && armed.has(name)) toStop.push(name);
  }
  return { toStop, toStart };
}

/** WRONG RULE B: one-way valve — it can stop a sweep but never re-start one. */
function planStopOnly(input: {
  eligible: readonly string[];
  armed: readonly string[];
  disabled: ReadonlySet<string>;
}): SweepReconcilePlan {
  const armed = new Set(input.armed);
  return {
    toStop: input.eligible.filter((n) => input.disabled.has(n) && armed.has(n)),
    toStart: [],
  };
}

describe('planSweepReconcile — the pure decision', () => {
  it('stops an armed sweep the operator disabled, and nothing else', () => {
    expect(
      planSweepReconcile({
        eligible: ['system-health', 'service-health'],
        armed: ['system-health', 'service-health'],
        disabled: new Set(['system-health']),
      }),
    ).toEqual({ toStop: ['system-health'], toStart: [] });
  });

  it('re-starts a sweep the operator turned back on — the switch is not a one-way valve', () => {
    const plan = planSweepReconcile({
      eligible: ['system-health', 'service-health'],
      armed: ['service-health'], // system-health was stopped by an earlier reconcile
      disabled: new Set(), // ...and has since been re-enabled
    });
    expect(plan).toEqual({ toStop: [], toStart: ['system-health'] });

    // NEGATIVE CONTROL B: the stop-only planner cannot produce this, so an implementation that
    // silently lost the re-start path would fail this assertion rather than pass it quietly.
    expect(
      planStopOnly({ eligible: ['system-health', 'service-health'], armed: ['service-health'], disabled: new Set() }),
    ).toEqual({ toStop: [], toStart: [] });
  });

  it('treats an UNKNOWN sweep as armed — absence of a row is not a disable (fail-open)', () => {
    const eligible = ['system-health', 'service-health'];
    expect(planSweepReconcile({ eligible, armed: eligible, disabled: new Set() })).toEqual({
      toStop: [],
      toStart: [],
    });

    // NEGATIVE CONTROL A: the fail-closed planner stops BOTH sweeps from the same input. If the
    // real planner ever adopted that rule, this expectation is what separates them.
    expect(planFailClosed({ eligible, armed: eligible, disabled: new Set() })).toEqual({
      toStop: ['system-health', 'service-health'],
      toStart: [],
    });
  });

  it('never starts a sweep this process is not eligible to run (cluster-scope stays honoured)', () => {
    // `eligible` is the post-scope-filter set; a host-scoped sweep left to the cluster primary is
    // simply absent from it and must not be conjured by a reconcile.
    const plan = planSweepReconcile({
      eligible: ['process-scoped'],
      armed: ['process-scoped'],
      disabled: new Set(),
    });
    expect(plan.toStart).not.toContain('host-scoped');
    expect(plan).toEqual({ toStop: [], toStart: [] });
  });

  it('is a no-op when the live set already matches the durable one', () => {
    expect(
      planSweepReconcile({ eligible: ['a', 'b'], armed: ['b'], disabled: new Set(['a']) }),
    ).toEqual({ toStop: [], toStart: [] });
  });
});

describe('reconcileSweepArmStateOnce — the failure semantics', () => {
  const deps = (over: Partial<SweepArmReconcilerDeps> = {}): SweepArmReconcilerDeps => ({
    eligible: () => [{ name: 'system-health', intervalMs: 1000 }],
    armed: () => ['system-health'],
    apply: (p) => ({ toStop: [...p.toStop], toStart: [...p.toStart] }),
    readDisabled: async () => new Set<string>(),
    ...over,
  });

  it('leaves every sweep armed when the arm-state read throws, and never calls apply', async () => {
    const apply = vi.fn((p: SweepReconcilePlan) => p);
    const warn = vi.fn();
    const plan = await reconcileSweepArmStateOnce(
      deps({
        readDisabled: async () => {
          throw new Error('connection terminated');
        },
        apply,
        warn,
      }),
    );
    expect(plan).toEqual({ toStop: [], toStart: [] });
    expect(apply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving every sweep ARMED'));
  });

  it('CALIBRATION: the same harness does report a stop when the read succeeds', async () => {
    // Without this, the fail-open test above would also pass against a reconciler that never
    // stops anything at all.
    const apply = vi.fn((p: SweepReconcilePlan) => p);
    const plan = await reconcileSweepArmStateOnce(
      deps({ readDisabled: async () => new Set(['system-health']), apply }),
    );
    expect(plan).toEqual({ toStop: ['system-health'], toStart: [] });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('reports what apply ACTUALLY changed, not what was asked', async () => {
    // apply is the authority on the live set — it skips names it cannot act on. A reconciler that
    // echoed its own request would report a sweep as stopped while it kept ticking.
    const plan = await reconcileSweepArmStateOnce(
      deps({
        eligible: () => [
          { name: 'system-health', intervalMs: 1000 },
          { name: 'gone', intervalMs: 1000 },
        ],
        armed: () => ['system-health', 'gone'],
        readDisabled: async () => new Set(['system-health', 'gone']),
        apply: () => ({ toStop: ['system-health'], toStart: [] }),
      }),
    );
    expect(plan).toEqual({ toStop: ['system-health'], toStart: [] });
  });
});

describe('applyInProcessSweepArmState — the live effect on real timers', () => {
  it('a disabled sweep STOPS TICKING, and re-enabling it resumes in the same process', async () => {
    vi.useFakeTimers();
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    armInProcessPeriodicChecks({ checks: [check('a', 1000, a), check('b', 1000, b)] });

    await vi.advanceTimersByTimeAsync(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    expect(applyInProcessSweepArmState({ toStop: ['a'], toStart: [] })).toEqual({
      toStop: ['a'],
      toStart: [],
    });
    expect(inProcessPeriodicArmedNames()).toEqual(['b']);

    await vi.advanceTimersByTimeAsync(2000);
    expect(a).toHaveBeenCalledTimes(1); // stopped
    expect(b).toHaveBeenCalledTimes(3);

    // ...and back on. This is the half a one-way disarm would silently lose.
    expect(applyInProcessSweepArmState({ toStop: [], toStart: ['a'] })).toEqual({
      toStop: [],
      toStart: ['a'],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it('skips a name it cannot act on rather than reporting it as changed', async () => {
    vi.useFakeTimers();
    armInProcessPeriodicChecks({ checks: [check('a')] });
    expect(
      applyInProcessSweepArmState({ toStop: ['never-declared'], toStart: ['also-not-declared'] }),
    ).toEqual({ toStop: [], toStart: [] });
    expect(inProcessPeriodicArmedNames()).toEqual(['a']);
  });

  it('is a no-op when the suite was never armed in this process', () => {
    expect(inProcessPeriodicArmedNames()).toEqual([]);
    expect(applyInProcessSweepArmState({ toStop: [], toStart: ['a'] })).toEqual({
      toStop: [],
      toStart: [],
    });
  });

  it('exposes the eligible set with cadence, after the cluster-scope filter', () => {
    armInProcessPeriodicChecks({
      checks: [check('host-scoped', 60_000), { ...check('process-scoped', 5_000), scope: 'process' }],
      isPrimary: false, // a cluster WORKER: only the process-scoped check is eligible here
    });
    expect(inProcessPeriodicEligibleChecks()).toEqual([{ name: 'process-scoped', intervalMs: 5_000 }]);
  });
});

describe('the arm-state row is classified honestly', () => {
  it('cannot spend — it is fired by nothing', () => {
    expect(TARGET_ROLE_SPEND[IN_PROCESS_SWEEP_TARGET_ROLE]?.spend).toBe('none');
  });

  it('is not a `system:` role, so the missing-system-action auditor cannot mistake it for a dispatch target', () => {
    expect(IN_PROCESS_SWEEP_TARGET_ROLE.startsWith('system:')).toBe(false);
  });

  it('the reconciler itself is uncontrollable by design — a disableable one would wedge every switch', () => {
    // It registers as a watchdog precisely so the pane offers no toggle for it. If that ever
    // became `control:'routine'`, turning it off would leave no surface able to turn it back on.
    const c = routineControl({ source: 'managed', category: 'watchdog' });
    expect(c.control).toBe('none');
    expect(c.reason).toBe('watchdog');
    expect(SWEEP_ARM_RECONCILER_NAME).toBe('in-process-sweep-arm-reconcile');
  });
});
