import { describe, it, expect } from 'vitest';
import { reconcile, summarizeReconcile, scopeUnitOf, type ScannedProcess } from './reconcile';
import { classifyScope } from './scope-class';
import type { TaskRow, TaskState } from './types';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const OLD = new Date(NOW - 10 * 60_000).toISOString();
const JUST_NOW = new Date(NOW - 2_000).toISOString();

const OUR_SLICE = '/user.slice/user-1000.slice/user@1000.service/papercusp.slice';

function row(over: Partial<TaskRow> & { taskId: string }): TaskRow {
  return {
    workspaceId: 'w',
    rootTaskId: over.taskId,
    class: 'bash-job',
    title: 't',
    argv: ['echo'],
    confined: true,
    state: 'running' as TaskState,
    startedAt: OLD,
    lastSeenAt: OLD,
    launchedBy: 'su-test',
    detail: {},
    ...over,
  };
}

function proc(over: Partial<ScannedProcess> & { pid: number }): ScannedProcess {
  const base = {
    cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice/pc-aaa111.scope`,
    processIdentity: `linux:boot:${over.pid}`,
    cmdline: 'node something',
    owned: true,
    ...over,
  };
  // Derive the scope discriminant from the SAME classifier production uses, so a
  // fixture can never assert a combination the real scan cannot produce. An
  // explicit `scope`/`exemptReason` in `over` still wins, for the cases that are
  // deliberately testing a mismatch.
  const derived = classifyScope(base.cgroupPath, base.owned);
  return { scope: derived.scope, exemptReason: derived.exemptReason, ...base };
}

describe('scopeUnitOf', () => {
  it('extracts our scope from the leaf segment', () => {
    expect(scopeUnitOf(proc({ pid: 1 }))).toBe('pc-aaa111.scope');
  });

  it('is null for a process that is merely inside our slice', () => {
    expect(scopeUnitOf(proc({ pid: 1, cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice` }))).toBeNull();
  });
});

describe('reconcile — alive matching', () => {
  it('matches by scope and counts the whole subtree', () => {
    const r = reconcile(
      [row({ taskId: 'aaa111', scopeUnit: 'pc-aaa111.scope' })],
      [proc({ pid: 100 }), proc({ pid: 231 }), proc({ pid: 232 })],
      { now: NOW },
    );
    expect(r.alive).toHaveLength(1);
    expect(r.alive[0]).toMatchObject({ taskId: 'aaa111', pid: 100, pidsSeen: 3, matchedBy: 'scope' });
    expect(r.stranded).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(0);
  });

  it('matches an unconfined row by kernel process identity', () => {
    const r = reconcile(
      [
        row({
          taskId: 'bbb222',
          confined: false,
          scopeUnit: null,
          processIdentity: 'linux:boot:55',
          pid: 55,
        }),
      ],
      [proc({ pid: 55, cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice`, processIdentity: 'linux:boot:55' })],
      { now: NOW },
    );
    expect(r.alive[0]).toMatchObject({ taskId: 'bbb222', matchedBy: 'identity' });
    expect(r.unaccounted).toHaveLength(0);
  });

  it('falls back to a bare pid ONLY when the row never captured an identity', () => {
    const r = reconcile(
      [row({ taskId: 'ccc333', confined: false, scopeUnit: null, processIdentity: null, pid: 77 })],
      [proc({ pid: 77, cgroupPath: `${OUR_SLICE}/x`, processIdentity: null })],
      { now: NOW },
    );
    expect(r.alive[0]).toMatchObject({ taskId: 'ccc333', matchedBy: 'pid' });
  });
});

describe('reconcile — PID recycling safety', () => {
  it('REFUSES to keep a row alive when its pid was recycled by another process', () => {
    // The single most dangerous case on this box: PID wrap happens ~daily under
    // fleet load. A row that recorded identity A must never be re-bound to a
    // stranger that merely inherited its pid — that is how a kill hits the
    // owner's desktop session.
    const r = reconcile(
      [
        row({
          taskId: 'ddd444',
          confined: false,
          scopeUnit: null,
          pid: 4242,
          processIdentity: 'linux:boot:1111',
        }),
      ],
      [proc({ pid: 4242, cgroupPath: `${OUR_SLICE}/x`, processIdentity: 'linux:boot:9999' })],
      { now: NOW },
    );
    expect(r.alive).toHaveLength(0);
    expect(r.stranded).toHaveLength(1);
    expect(r.stranded[0]!.reason).toMatch(/identity linux:boot:1111 is gone/);
    // …and the stranger is reported as residue rather than silently adopted.
    expect(r.unaccounted.flatMap((g) => g.pids)).toContain(4242);
  });
});

describe('reconcile — stranding', () => {
  it('strands a row whose scope holds no processes', () => {
    const r = reconcile([row({ taskId: 'eee555', scopeUnit: 'pc-eee555.scope' })], [], { now: NOW });
    expect(r.stranded).toEqual([
      { taskId: 'eee555', reason: 'scope pc-eee555.scope holds no processes' },
    ]);
  });

  it('does NOT strand a row that is younger than the grace window', () => {
    // register -> fork -> visible-in-cgroup is not instantaneous. Stranding a row
    // in that window would kill-report healthy tasks on every tick.
    const r = reconcile(
      [row({ taskId: 'fff666', scopeUnit: 'pc-fff666.scope', startedAt: JUST_NOW, lastSeenAt: JUST_NOW })],
      [],
      { now: NOW },
    );
    expect(r.stranded).toHaveLength(0);
    expect(r.tooYoung).toEqual(['fff666']);
  });

  it('uses the NEWER of startedAt / lastSeenAt for the age test', () => {
    // A long-running task seen 2s ago is not "10 minutes old and absent".
    const r = reconcile(
      [row({ taskId: 'ggg777', scopeUnit: 'pc-ggg777.scope', startedAt: OLD, lastSeenAt: JUST_NOW })],
      [],
      { now: NOW },
    );
    expect(r.stranded).toHaveLength(0);
    expect(r.tooYoung).toEqual(['ggg777']);
  });

  it('ignores rows already in a terminal state', () => {
    const r = reconcile([row({ taskId: 'hhh888', state: 'exited', scopeUnit: 'pc-hhh888.scope' })], [], {
      now: NOW,
    });
    expect(r.stranded).toHaveLength(0);
    expect(r.alive).toHaveLength(0);
  });

  it('never treats residue classifications as ours to signal', () => {
    const r = reconcile(
      [
        row({ taskId: 'iii999', state: 'unaccounted', scopeUnit: 'pc-iii999.scope' }),
        row({ taskId: 'jjj000', state: 'foreign', scopeUnit: null, pid: 5 }),
      ],
      [],
      { now: NOW },
    );
    expect(r.alive).toHaveLength(0);
    expect(r.stranded).toHaveLength(0);
  });
});

describe('reconcile — residue (the no-escape signal)', () => {
  it('flags a process inside our slice with no ledger row', () => {
    const r = reconcile([], [proc({ pid: 900 }), proc({ pid: 901 })], { now: NOW });
    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]).toMatchObject({
      scopeUnit: 'pc-aaa111.scope',
      pids: [900, 901],
    });
    expect(r.foreign).toHaveLength(0);
  });

  it('flags a bypass that is in our slice but NOT in any pc- scope', () => {
    // The literal "someone escaped the chokepoint" shape: it inherited our slice
    // (so the kernel still holds it) but no managedSpawn ever named it.
    const r = reconcile([], [proc({ pid: 902, cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice` })], {
      now: NOW,
    });
    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]!.scopeUnit).toBeNull();
  });

  it('separates FOREIGN (outside our slice) from unaccounted — visibility, not control', () => {
    const r = reconcile(
      [],
      [
        proc({
          pid: 903,
          owned: false,
          cgroupPath: '/user.slice/user-1000.slice/session-3.scope',
          cmdline: 'npm run dev',
        }),
      ],
      { now: NOW },
    );
    expect(r.unaccounted).toHaveLength(0);
    expect(r.foreign).toHaveLength(1);
    expect(r.foreign[0]!.sampleCmdline).toBe('npm run dev');
  });

  it('does not report a claimed scope as residue', () => {
    const r = reconcile(
      [row({ taskId: 'aaa111', scopeUnit: 'pc-aaa111.scope' })],
      [proc({ pid: 100 })],
      { now: NOW },
    );
    expect(r.unaccounted).toHaveLength(0);
  });

  it('groups residue by cgroup path so one runaway subtree is ONE alarm', () => {
    const r = reconcile(
      [],
      [
        proc({ pid: 1, cgroupPath: `${OUR_SLICE}/a` }),
        proc({ pid: 2, cgroupPath: `${OUR_SLICE}/a` }),
        proc({ pid: 3, cgroupPath: `${OUR_SLICE}/b` }),
      ],
      { now: NOW },
    );
    expect(r.unaccounted.map((g) => g.pids)).toEqual([[1, 2], [3]]);
  });
});

describe('reconcile — deadlines', () => {
  it('reports a live row past its deadline', () => {
    const r = reconcile(
      [
        row({
          taskId: 'kkk111',
          scopeUnit: 'pc-kkk111.scope',
          deadlineAt: new Date(NOW - 5_000).toISOString(),
        }),
      ],
      [proc({ pid: 10, cgroupPath: `${OUR_SLICE}/x/pc-kkk111.scope` })],
      { now: NOW },
    );
    expect(r.overdue).toEqual([
      { taskId: 'kkk111', deadlineAt: new Date(NOW - 5_000).toISOString(), overdueMs: 5_000 },
    ]);
  });

  it('does not report a deadline still in the future', () => {
    const r = reconcile(
      [
        row({
          taskId: 'lll222',
          scopeUnit: 'pc-lll222.scope',
          deadlineAt: new Date(NOW + 60_000).toISOString(),
        }),
      ],
      [proc({ pid: 10, cgroupPath: `${OUR_SLICE}/x/pc-lll222.scope` })],
      { now: NOW },
    );
    expect(r.overdue).toHaveLength(0);
  });
});

describe('summarizeReconcile', () => {
  it('counts residue by group AND by pid', () => {
    const r = reconcile(
      [row({ taskId: 'mmm333', scopeUnit: 'pc-mmm333.scope' })],
      [proc({ pid: 1, cgroupPath: `${OUR_SLICE}/a` }), proc({ pid: 2, cgroupPath: `${OUR_SLICE}/a` })],
      { now: NOW },
    );
    expect(summarizeReconcile(r)).toMatchObject({
      alive: 0,
      stranded: 1,
      unaccounted: 1,
      unaccountedPids: 2,
      foreign: 0,
    });
  });
});
