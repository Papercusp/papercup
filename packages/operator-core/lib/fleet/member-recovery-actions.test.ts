/**
 * member-recovery-actions.test.ts — recurrence guard for P-009's IO half.
 *
 * The decision core's tests prove WHAT should happen. These prove the side effects actually
 * happen, in the right ORDER, and — the part that matters most on a failure path — that a
 * partial success is never reported as containment.
 */
import { describe, it, expect, vi } from 'vitest';
import { decideMemberRecovery, type MemberRecoveryDecision } from './member-recovery';
import { strandWedgedMember, type StrandMemberDeps } from './member-recovery-actions';

const FLEET = 'goal-070565-fleet-friction';
const MEMBER = 'su-wedged-member';

function strandedDecision(): MemberRecoveryDecision {
  const d = decideMemberRecovery({
    fleetSlug: FLEET,
    memberOwnerId: MEMBER,
    leaderOwnerId: 'su-leader',
    attemptKey: 'a1',
    kill: 'failed',
    now: 1_756_000_000_000,
  });
  // Guard the fixture itself: if the core ever stops stranding a failed kill, these tests would
  // silently start exercising a different path while still passing.
  expect(d.disposition).toBe('stranded');
  return d;
}

function deps(over: Partial<StrandMemberDeps> = {}): StrandMemberDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listTasks: async () => {
      calls.push('listTasks');
      return [{ taskId: 'task-1' }];
    },
    freezeTask: async (taskId) => {
      calls.push(`freezeTask:${taskId}`);
      return { ok: true };
    },
    markStranded: async (v) => {
      calls.push('markStranded');
      return v.length;
    },
    emitTransition: () => {
      calls.push('emitTransition');
    },
    ...over,
  } as StrandMemberDeps & { calls: string[] };
}

describe('strandWedgedMember', () => {
  it('freezes, then marks stranded, then emits — in that order', async () => {
    // Order is the invariant, not just the set of calls: marking a row `stranded` before the
    // freeze lands records that the work stopped while it is still running.
    const d = deps();
    await strandWedgedMember({ fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() }, d);
    expect(d.calls).toEqual(['listTasks', 'freezeTask:task-1', 'markStranded', 'emitTransition']);
  });

  it('reports containment only when every resolved task was actually frozen', async () => {
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps(),
    );
    expect(r.contained).toBe(true);
    expect(r.tasks).toEqual([{ taskId: 'task-1', frozen: true }]);
    expect(r.markedStranded).toBe(1);
    expect(r.transitionEmitted).toBe(true);
  });

  it('does NOT report containment when a freeze fails, but still marks the row', async () => {
    // The unconfined-task case. We could not stop it, so `contained` must be false — and the
    // ledger row must still be marked, because an unaccounted running task is what `stranded` is.
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps({ freezeTask: async () => ({ ok: false, error: 'unsupported' }) }),
    );
    expect(r.contained).toBe(false);
    expect(r.tasks[0]).toMatchObject({ frozen: false, freezeError: 'unsupported' });
    expect(r.markedStranded).toBe(1);
  });

  it('records the freeze failure IN the strand reason, so the ledger never implies containment', async () => {
    const markStranded = vi.fn(async (v: readonly { taskId: string; reason: string }[]) => v.length);
    await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps({ freezeTask: async () => ({ ok: false, error: 'unsupported' }), markStranded }),
    );
    expect(markStranded.mock.calls[0]![0]![0]!.reason).toContain('FREEZE FAILED: unsupported');
  });

  it('marks a frozen row with the [frozen] marker, so the two cases are distinguishable', async () => {
    const markStranded = vi.fn(async (v: readonly { taskId: string; reason: string }[]) => v.length);
    await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps({ markStranded }),
    );
    expect(markStranded.mock.calls[0]![0]![0]!.reason).toContain('[frozen]');
  });

  it('never reports containment when the task enumeration itself failed', async () => {
    // The subtle one: zero tasks froze because we could not SEE any. Treating an empty list as
    // "nothing to contain" would report success for a member we never looked at.
    const onError = vi.fn();
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps({
        listTasks: async () => {
          throw new Error('pg down');
        },
        onError,
      }),
    );
    expect(r.contained).toBe(false);
    expect(r.noTasksFound).toBe(false);
    expect(onError).toHaveBeenCalledWith('listTasks', expect.any(Error));
  });

  it('distinguishes "no task rows exist" from "containment achieved"', async () => {
    // An unmanaged session has no ledger row by construction. That is not containment.
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps({ listTasks: async () => [] }),
    );
    expect(r.noTasksFound).toBe(true);
    expect(r.contained).toBe(false);
    expect(r.markedStranded).toBe(0);
  });

  it('carries the decision reason verbatim onto the transition edge', async () => {
    // The acceptance criterion: the reason travels with the event. A downstream reader must get
    // the cause without going back to the logs.
    const emitTransition = vi.fn();
    const decision = strandedDecision();
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision },
      deps({ emitTransition }),
    );
    expect(emitTransition).toHaveBeenCalledWith({
      kind: 'member-stalled',
      reason: decision.reason,
      memberOwnerId: MEMBER,
      fleetSlug: FLEET,
    });
    expect(r.reason).toBe(decision.reason);
  });

  it('survives every dependency throwing — a recovery helper must not add a second exception', async () => {
    // This runs on a path where something has already failed. Throwing here replaces the
    // leader's diagnosis with a stack trace.
    const onError = vi.fn();
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps({
        freezeTask: async () => {
          throw new Error('cgroup gone');
        },
        markStranded: async () => {
          throw new Error('pg down');
        },
        emitTransition: () => {
          throw new Error('emitter gone');
        },
        onError,
      }),
    );
    expect(r.contained).toBe(false);
    expect(r.transitionEmitted).toBe(false);
    expect(r.markedStranded).toBe(0);
    expect(onError.mock.calls.map((c) => c[0])).toEqual(['freezeTask', 'markStranded', 'emitTransition']);
  });

  it('freezes EVERY task the member owns, not just the first', async () => {
    // A member's subtree can carry several enrolled tasks; freezing one leaves the rest running.
    const d = deps({ listTasks: async () => [{ taskId: 't1' }, { taskId: 't2' }, { taskId: 't3' }] });
    const r = await strandWedgedMember({ fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() }, d);
    expect(d.calls.filter((c) => c.startsWith('freezeTask:'))).toEqual([
      'freezeTask:t1',
      'freezeTask:t2',
      'freezeTask:t3',
    ]);
    expect(r.contained).toBe(true);
  });

  it('one un-frozen task among several drags containment to false', async () => {
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: strandedDecision() },
      deps({
        listTasks: async () => [{ taskId: 't1' }, { taskId: 't2' }],
        freezeTask: async (taskId) => (taskId === 't2' ? { ok: false, error: 'unsupported' } : { ok: true }),
      }),
    );
    expect(r.contained).toBe(false);
    expect(r.tasks.filter((t) => t.frozen)).toHaveLength(1);
  });

  it('does not emit a transition when the decision carries none', async () => {
    const emitTransition = vi.fn();
    const noTransition = { ...strandedDecision(), transition: null };
    const r = await strandWedgedMember(
      { fleetSlug: FLEET, memberOwnerId: MEMBER, decision: noTransition },
      deps({ emitTransition }),
    );
    expect(emitTransition).not.toHaveBeenCalled();
    expect(r.transitionEmitted).toBe(false);
  });
});
