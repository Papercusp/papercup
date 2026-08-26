/**
 * Tests for the acceptance-grading stall sweep's pure decision core.
 * plan: acceptance-grading-stall-sweep-2026-08-26 (P-001, extended by P-005)
 *
 * Two things here are deliberate and should survive future edits:
 *
 * 1. The DRIFT PINS read their counterpart constants out of the source TEXT rather
 *    than importing the modules that define them. `acceptance-grader.ts` and
 *    `set-plan-status.ts` both sit on a DB-bound dependency graph; importing either
 *    would cost this suite the no-database property the pure core exists to have.
 *    Text-pinning is the repo's established way to hold prose and constants against
 *    code (`lib/doc-claims/`), and it fails loudly on a rename rather than silently
 *    passing.
 *
 * 2. The CONTROL at the bottom is a permanently-wrong implementation kept beside the
 *    real one. A guard test that has never failed is a guard nobody has tested; the
 *    control proves these properties can fail, without mutating the shared tree
 *    (repo policy: mutation-probe tier 1 for an imported module).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_GRADING_ESCALATE_AFTER_MS,
  ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS,
  ACCEPTANCE_GRADING_STALL_GATE_CODES,
  ACCEPTANCE_GRADING_SWEEP_MAX_PER_TICK,
  decideAcceptanceGradingAction,
  planAcceptanceGradingSweep,
  type AcceptanceGradingCandidate,
} from './acceptance-grading-sweep';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

/** A candidate that IS stuck on a grader gap — every test starts from this and
 *  changes exactly the one field under examination. */
const stuck = (over: Partial<AcceptanceGradingCandidate> = {}): AcceptanceGradingCandidate => ({
  planSlug: 'some-plan-2026-08-26',
  gateSatisfied: false,
  gateCode: 'acceptance_ungraded',
  stuckSinceMs: NOW - 3 * HOUR,
  lastDispatchMs: null,
  graderLive: false,
  escalationExists: false,
  ...over,
});

describe('drift pins — the core must not diverge from the live gate', () => {
  it('re-dispatch window equals the grader machinery ACCEPTANCE_GRADER_STALE_AFTER_MS', () => {
    const src = readFileSync(join(__dirname, 'acceptance-grader.ts'), 'utf8');
    const m = src.match(/export const ACCEPTANCE_GRADER_STALE_AFTER_MS\s*=\s*([^;]+);/);
    expect(
      m,
      'ACCEPTANCE_GRADER_STALE_AFTER_MS was renamed or removed in acceptance-grader.ts — re-point this pin',
    ).toBeTruthy();
    // eslint-disable-next-line no-eval
    const staleAfterMs = eval(m![1]!) as number;
    expect(
      ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS,
      'the sweep re-dispatches at the same age the grader machinery already calls a receipt stale; ' +
        'if that constant moved, move this one with it (or state why they now differ)',
    ).toBe(staleAfterMs);
  });

  it('stall gate codes match the set the live gate uses to recruit a grader', () => {
    const src = readFileSync(join(__dirname, 'agent-tools/plans/set-plan-status.ts'), 'utf8');
    const m = src.match(/export const ACCEPTANCE_GRADER_GATE_CODES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    expect(
      m,
      'ACCEPTANCE_GRADER_GATE_CODES was renamed, un-exported or reshaped in set-plan-status.ts — re-point this pin',
    ).toBeTruthy();
    const live = m![1]!
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .sort();
    expect([...ACCEPTANCE_GRADING_STALL_GATE_CODES].sort()).toEqual(live);
  });

  it('escalation window is a whole number of re-dispatch windows and strictly longer', () => {
    expect(ACCEPTANCE_GRADING_ESCALATE_AFTER_MS).toBeGreaterThan(ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS);
    expect(ACCEPTANCE_GRADING_ESCALATE_AFTER_MS % ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS).toBe(0);
  });
});

describe('R6 — a plan that is not stuck on a grader is left alone', () => {
  it('skips a satisfied gate', () => {
    const d = decideAcceptanceGradingAction(stuck({ gateSatisfied: true }), NOW);
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('gate-satisfied');
  });

  it.each([
    'acceptance_rubric_missing',
    'acceptance_rubric_unvetted',
    'acceptance_not_recorded',
    'acceptance_rejected',
    'plan_items_unfinished',
    'acceptance_unaudited',
    'audit_coverage_stale',
    'audit_citations_unresolved',
  ] as const)('skips %s — that is the author\'s work, not a grader\'s', (code) => {
    const d = decideAcceptanceGradingAction(stuck({ gateCode: code, stuckSinceMs: NOW - 99 * HOUR }), NOW);
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('not-a-grader-gap');
  });

  it('skips when the gate refused with no code at all', () => {
    expect(decideAcceptanceGradingAction(stuck({ gateCode: null }), NOW).reason).toBe('not-a-grader-gap');
  });

  it('declines to act on an unknown stuck age rather than guessing', () => {
    const d = decideAcceptanceGradingAction(stuck({ stuckSinceMs: null }), NOW);
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('stuck-age-unknown');
    expect(d.stuckForMs).toBeNull();
  });

  it('leaves a freshly-stuck plan inside the grace window alone', () => {
    const d = decideAcceptanceGradingAction(stuck({ stuckSinceMs: NOW - 1 * HOUR }), NOW);
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('within-redispatch-grace');
  });
});

describe('R2 — repeated ticks are safe', () => {
  it('never disturbs a live grader, however long the plan has been stuck', () => {
    const d = decideAcceptanceGradingAction(
      stuck({ graderLive: true, stuckSinceMs: NOW - 1000 * HOUR }),
      NOW,
    );
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('grader-live');
  });

  it('does not re-dispatch again inside the cooling window', () => {
    const d = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - 5 * HOUR, lastDispatchMs: NOW - 1 * HOUR }),
      NOW,
    );
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('redispatch-cooling');
  });

  it('re-dispatches once the previous dispatch has had its full window', () => {
    const d = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - 5 * HOUR, lastDispatchMs: NOW - 3 * HOUR }),
      NOW,
    );
    expect(d.action).toBe('dispatch');
  });

  it('is deterministic — the same inputs decide the same way every time', () => {
    const c = stuck({ stuckSinceMs: NOW - 5 * HOUR });
    expect(decideAcceptanceGradingAction(c, NOW)).toEqual(decideAcceptanceGradingAction(c, NOW));
  });
});

describe('R1 — a stalled plan is re-dispatched with no human and no creator', () => {
  it('dispatches at exactly the re-dispatch boundary', () => {
    const at = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS }),
      NOW,
    );
    expect(at.action).toBe('dispatch');
    expect(at.reason).toBe('stalled-past-redispatch');
  });

  it('does not dispatch one millisecond before the boundary', () => {
    const just = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS + 1 }),
      NOW,
    );
    expect(just.action).toBe('skip');
  });

  it('dispatches for self_graded_only too, not only acceptance_ungraded', () => {
    const d = decideAcceptanceGradingAction(stuck({ gateCode: 'self_graded_only' }), NOW);
    expect(d.action).toBe('dispatch');
  });
});

describe('R3 — a long stall reaches exactly one owner', () => {
  it('escalates past the escalation window', () => {
    const d = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - ACCEPTANCE_GRADING_ESCALATE_AFTER_MS }),
      NOW,
    );
    expect(d.action).toBe('escalate');
    expect(d.reason).toBe('stalled-past-escalation');
  });

  it('escalation takes precedence over another re-dispatch', () => {
    const d = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - 50 * HOUR, lastDispatchMs: NOW - 40 * HOUR }),
      NOW,
    );
    expect(d.action).toBe('escalate');
  });

  it('stops entirely once an escalation exists — the second tick mints nothing', () => {
    const first = decideAcceptanceGradingAction(stuck({ stuckSinceMs: NOW - 50 * HOUR }), NOW);
    expect(first.action).toBe('escalate');
    // The action module records the minted item; the next tick sees it and stands down.
    const second = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - 50 * HOUR, escalationExists: true }),
      NOW,
    );
    expect(second.action).toBe('skip');
    expect(second.reason).toBe('already-escalated');
  });

  it('an existing escalation also suppresses re-dispatch, not just further escalation', () => {
    const d = decideAcceptanceGradingAction(
      stuck({ stuckSinceMs: NOW - 5 * HOUR, escalationExists: true }),
      NOW,
    );
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('already-escalated');
  });
});

describe('R5 — one tick is bounded', () => {
  const manyStalled = (n: number): AcceptanceGradingCandidate[] =>
    Array.from({ length: n }, (_, i) =>
      stuck({ planSlug: `plan-${String(i).padStart(3, '0')}`, stuckSinceMs: NOW - (3 + i) * HOUR }),
    );

  it('caps actionable work and reports what it deferred', () => {
    const out = planAcceptanceGradingSweep(manyStalled(25), NOW, { maxPerTick: 10 });
    expect(out.actionable).toHaveLength(10);
    expect(out.deferredByCap).toBe(15);
    expect(out.decisions).toHaveLength(25);
  });

  it('defaults to the exported per-tick ceiling', () => {
    const out = planAcceptanceGradingSweep(manyStalled(500), NOW);
    expect(out.actionable).toHaveLength(ACCEPTANCE_GRADING_SWEEP_MAX_PER_TICK);
  });

  it('skips are never capped — deciding to do nothing costs nothing', () => {
    const out = planAcceptanceGradingSweep(
      Array.from({ length: 50 }, (_, i) => stuck({ planSlug: `p-${i}`, gateSatisfied: true })),
      NOW,
      { maxPerTick: 2 },
    );
    expect(out.actionable).toHaveLength(0);
    expect(out.deferredByCap).toBe(0);
    expect(out.counts.skipped).toBe(50);
  });

  it('spends the cap on the MOST-stalled plans, regardless of input order', () => {
    const shuffled = [...manyStalled(6)].reverse();
    const out = planAcceptanceGradingSweep(shuffled, NOW, { maxPerTick: 2 });
    // plan-005 is the oldest (3+5 h), plan-004 next.
    expect(out.actionable.map((d) => d.planSlug)).toEqual(['plan-005', 'plan-004']);
  });

  it('counts dispatch and escalate separately', () => {
    const out = planAcceptanceGradingSweep(
      [
        stuck({ planSlug: 'a', stuckSinceMs: NOW - 3 * HOUR }),
        stuck({ planSlug: 'b', stuckSinceMs: NOW - 99 * HOUR }),
        stuck({ planSlug: 'c', gateSatisfied: true }),
      ],
      NOW,
    );
    expect(out.counts).toEqual({ skipped: 1, dispatch: 1, escalate: 1 });
  });

  it('a zero cap is honoured rather than treated as unlimited', () => {
    const out = planAcceptanceGradingSweep(manyStalled(3), NOW, { maxPerTick: 0 });
    expect(out.actionable).toHaveLength(0);
    expect(out.deferredByCap).toBe(3);
  });
});

/**
 * FALSIFIABILITY CONTROL — permanent, deliberately wrong, never exported.
 *
 * `brokenDecide` is the same decision with the live-grader guard removed: the single
 * most tempting simplification, and the one that would turn a safe periodic sweep
 * into a grader-launch storm. The properties below assert that the REAL core holds a
 * property AND that the broken one visibly fails it. If someone deletes the guard,
 * the "real" half of these tests fails; if someone weakens the test itself so that a
 * broken implementation would pass, the control half fails. One of the two catches it.
 */
function brokenDecide(candidate: AcceptanceGradingCandidate, nowMs: number) {
  const stuckForMs = candidate.stuckSinceMs === null ? null : nowMs - (candidate.stuckSinceMs ?? nowMs);
  if (candidate.gateSatisfied) return { action: 'skip' as const, stuckForMs };
  if (!candidate.gateCode || !ACCEPTANCE_GRADING_STALL_GATE_CODES.includes(candidate.gateCode)) {
    return { action: 'skip' as const, stuckForMs };
  }
  if (candidate.escalationExists) return { action: 'skip' as const, stuckForMs };
  if (stuckForMs === null) return { action: 'skip' as const, stuckForMs };
  if (stuckForMs >= ACCEPTANCE_GRADING_ESCALATE_AFTER_MS) return { action: 'escalate' as const, stuckForMs };
  if (stuckForMs < ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS) return { action: 'skip' as const, stuckForMs };
  return { action: 'dispatch' as const, stuckForMs }; // ← omits the graderLive guard
}

describe('falsifiability control — these properties CAN fail', () => {
  const withLiveGrader = stuck({ graderLive: true, stuckSinceMs: NOW - 5 * HOUR });

  it('CALIBRATION: the real core and the control agree when no grader is live', () => {
    // Without this, both halves below could pass while the property itself is broken.
    const noGrader = stuck({ stuckSinceMs: NOW - 5 * HOUR });
    expect(decideAcceptanceGradingAction(noGrader, NOW).action).toBe(brokenDecide(noGrader, NOW).action);
  });

  it('the real core never duplicates a live grader', () => {
    expect(decideAcceptanceGradingAction(withLiveGrader, NOW).action).toBe('skip');
  });

  it('CONTROL: an implementation missing the guard DOES duplicate it', () => {
    expect(brokenDecide(withLiveGrader, NOW).action).toBe('dispatch');
  });

  it('CONTROL: at fleet scale the missing guard is a launch storm, not one stray call', () => {
    const busy = Array.from({ length: 20 }, (_, i) =>
      stuck({ planSlug: `p-${i}`, graderLive: true, stuckSinceMs: NOW - 5 * HOUR }),
    );
    expect(planAcceptanceGradingSweep(busy, NOW).actionable).toHaveLength(0);
    expect(busy.filter((c) => brokenDecide(c, NOW).action === 'dispatch')).toHaveLength(20);
  });
});
