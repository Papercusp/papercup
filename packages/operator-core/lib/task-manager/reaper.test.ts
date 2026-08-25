/**
 * reaper.test.ts — falsifiability suite for the reap decision core (WI-41607).
 *
 * Every spared class has a CONTROL case (a row that must NOT be reaped) and
 * every reaped class a CAUGHT case, so a regression that widens or narrows the
 * discriminator fails here rather than on the live box. The quiet-zombie cases
 * drive the REAL census (censusAgentSessionProgress) with an injected mtime
 * reader rather than a hand-built census object, so the two modules cannot
 * drift apart silently.
 */

import { describe, expect, it } from 'vitest';

import {
  censusAgentSessionProgress,
  DEFAULT_QUIET_MS,
} from './agent-session-progress-census';
import {
  decideReaps,
  executeReaps,
  REAP_MAX_PER_TICK,
  REAP_TERMINAL_GRACE_MS,
  rowOwnerId,
  type ReapDecision,
} from './reaper';
import type { TaskRow } from './types';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const HOUR = 3600_000;

function row(partial: Partial<TaskRow> & { taskId: string }): TaskRow {
  return {
    workspaceId: 'papercusp-workspace',
    rootTaskId: partial.taskId,
    class: 'agent-session',
    title: 'test session',
    argv: ['psu'],
    confined: true,
    state: 'running',
    startedAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    scopeUnit: `pc-${partial.taskId}--test.scope`,
    logPath: `/logs/${partial.taskId}.log`,
    detail: {},
    ...partial,
  } as TaskRow;
}

/** Drive the REAL census over the live rows with a fixed mtime table. */
function census(rows: TaskRow[], mtimes: Record<string, number | null>) {
  return censusAgentSessionProgress(rows, {
    statMtimeMs: (p) => (p in mtimes ? mtimes[p] : null),
    now: NOW,
  });
}

function decide(
  rows: TaskRow[],
  opts: {
    mtimes?: Record<string, number | null>;
    pids?: Record<string, number | null>;
    freshOwners?: string[];
    maxPerTick?: number;
  } = {},
) {
  return decideReaps({
    rows,
    census: census(rows, opts.mtimes ?? {}),
    scopePidCount: (r) => (opts.pids ? (r.taskId in opts.pids ? opts.pids[r.taskId] : 0) : 0),
    freshOwners: new Set(opts.freshOwners ?? []),
    now: NOW,
    maxPerTick: opts.maxPerTick,
  });
}

describe('terminal-residue class', () => {
  it('reaps a terminal row whose scope still holds processes past the grace window (CAUGHT)', () => {
    const r = row({
      taskId: 't1',
      state: 'exited',
      endedAt: new Date(NOW - REAP_TERMINAL_GRACE_MS - 60_000).toISOString(),
    });
    const v = decide([r], { pids: { t1: 6 } });
    expect(v.reap).toHaveLength(1);
    expect(v.reap[0]).toMatchObject({ taskId: 't1', kind: 'terminal-residue' });
  });

  it('waits out the grace window (CONTROL)', () => {
    const r = row({
      taskId: 't2',
      state: 'exited',
      endedAt: new Date(NOW - REAP_TERMINAL_GRACE_MS + 60_000).toISOString(),
    });
    expect(decide([r], { pids: { t2: 6 } }).reap).toHaveLength(0);
  });

  it('treats an unreadable cgroup as NOT having processes — null is never residue (CONTROL)', () => {
    const r = row({ taskId: 't3', state: 'exited', endedAt: new Date(NOW - HOUR).toISOString() });
    expect(decide([r], { pids: { t3: null } }).reap).toHaveLength(0);
  });

  it('leaves an emptied scope to systemd collection (CONTROL)', () => {
    const r = row({ taskId: 't4', state: 'exited', endedAt: new Date(NOW - HOUR).toISOString() });
    expect(decide([r], { pids: { t4: 0 } }).reap).toHaveLength(0);
  });
});

describe('quiet-zombie class', () => {
  const quietMtime = NOW - DEFAULT_QUIET_MS - 2 * HOUR;
  const freshMtime = NOW - 5 * 60_000;

  it('reaps a running row whose log has been quiet past the window with no fresh presence (CAUGHT)', () => {
    const r = row({ taskId: 'q1' });
    const v = decide([r], { mtimes: { '/logs/q1.log': quietMtime }, pids: { q1: 6 } });
    expect(v.reap).toHaveLength(1);
    expect(v.reap[0]).toMatchObject({ taskId: 'q1', kind: 'quiet-zombie' });
  });

  it('spares a quiet row whose owner has a fresh presence heartbeat (CONTROL)', () => {
    const r = row({ taskId: 'q2', detail: { ownerId: 'su-abc' } });
    const v = decide([r], {
      mtimes: { '/logs/q2.log': quietMtime },
      pids: { q2: 6 },
      freshOwners: ['su-abc'],
    });
    expect(v.reap).toHaveLength(0);
    expect(v.spared.some((s) => s.taskId === 'q2' && /heartbeat fresh/.test(s.why))).toBe(true);
  });

  it('never touches a log-active row (CONTROL — the validated KEEP rule)', () => {
    const r = row({ taskId: 'q3' });
    const v = decide([r], { mtimes: { '/logs/q3.log': freshMtime }, pids: { q3: 6 } });
    expect(v.reap).toHaveLength(0);
  });

  it('never reaps no-log / unreadable-log rows — instrument failure is not quiet (CONTROL)', () => {
    const noLog = row({ taskId: 'q4', logPath: null });
    const unreadable = row({ taskId: 'q5' }); // absent from mtimes table -> stat null
    const v = decide([noLog, unreadable], { pids: { q4: 6, q5: 6 } });
    expect(v.reap).toHaveLength(0);
  });

  it('disables the whole quiet class on a DEGRADED census, terminal class unaffected (CONTROL)', () => {
    // 3 unreadable vs 1 quiet -> degraded census per the census's own rule.
    const rows = [
      row({ taskId: 'd1' }),
      row({ taskId: 'd2' }),
      row({ taskId: 'd3' }),
      row({ taskId: 'd4' }),
      row({
        taskId: 'd5',
        state: 'killed',
        endedAt: new Date(NOW - HOUR).toISOString(),
      }),
    ];
    const v = decide(rows, {
      mtimes: { '/logs/d4.log': quietMtime }, // d1-d3 unreadable, d4 quiet
      pids: { d1: 6, d2: 6, d3: 6, d4: 6, d5: 6 },
    });
    expect(v.quietClassDisabled).toBe(true);
    expect(v.reap.map((x) => x.kind)).toEqual(['terminal-residue']);
  });
});

describe('shared rails', () => {
  it('never reaps an autoReapExempt row, even terminal residue (CONTROL — D-001)', () => {
    const r = row({
      taskId: 'e1',
      state: 'exited',
      endedAt: new Date(NOW - HOUR).toISOString(),
      detail: { autoReapExempt: true },
    });
    const v = decide([r], { pids: { e1: 6 } });
    expect(v.reap).toHaveLength(0);
    expect(v.spared.some((s) => s.taskId === 'e1' && /autoReapExempt/.test(s.why))).toBe(true);
  });

  it('never touches a non-agent-session class (CONTROL)', () => {
    const r = row({
      taskId: 'e2',
      class: 'bash-job',
      state: 'exited',
      endedAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(decide([r], { pids: { e2: 6 } }).reap).toHaveLength(0);
  });

  it('caps per tick and reports the deferred remainder', () => {
    const rows = Array.from({ length: REAP_MAX_PER_TICK + 3 }, (_, i) =>
      row({
        taskId: `c${i}`,
        state: 'exited',
        endedAt: new Date(NOW - HOUR).toISOString(),
      }),
    );
    const pids = Object.fromEntries(rows.map((r) => [r.taskId, 6]));
    const v = decide(rows, { pids });
    expect(v.reap).toHaveLength(REAP_MAX_PER_TICK);
    expect(v.deferred).toBe(3);
  });

  it('maps detail owner spellings and rejects blanks', () => {
    expect(rowOwnerId({ detail: { ownerId: 'su-x' } })).toBe('su-x');
    expect(rowOwnerId({ detail: { coordOwnerId: 'su-y' } })).toBe('su-y');
    expect(rowOwnerId({ detail: { owner: '' } })).toBeNull();
    expect(rowOwnerId({ detail: {} })).toBeNull();
  });
});

describe('executeReaps', () => {
  const decision: ReapDecision = {
    taskId: 'x1',
    scopeUnit: 'pc-x1--test.scope',
    logPath: '/logs/x1.log',
    kind: 'quiet-zombie',
    why: 'test',
  };

  it('archives BEFORE stopping, and closes the row only for quiet-zombies after a successful stop', async () => {
    const calls: string[] = [];
    const out = await executeReaps([decision], {
      archiveTail: async () => (calls.push('archive'), '/arch/x1.tail.log'),
      stopUnit: async () => (calls.push('stop'), true),
      closeAsReaped: async () => void calls.push('close'),
    });
    expect(calls).toEqual(['archive', 'stop', 'close']);
    expect(out[0]).toMatchObject({ ok: true, archived: '/arch/x1.tail.log' });
  });

  it('does not close the ledger row when the stop fails, and reports the failure', async () => {
    const calls: string[] = [];
    const out = await executeReaps([decision], {
      archiveTail: async () => null,
      stopUnit: async () => false,
      closeAsReaped: async () => void calls.push('close'),
    });
    expect(calls).toEqual([]);
    expect(out[0].ok).toBe(false);
  });

  it('does not re-close a terminal-residue row (already terminal by definition)', async () => {
    const calls: string[] = [];
    await executeReaps([{ ...decision, kind: 'terminal-residue' }], {
      archiveTail: async () => null,
      stopUnit: async () => true,
      closeAsReaped: async () => void calls.push('close'),
    });
    expect(calls).toEqual([]);
  });
});
