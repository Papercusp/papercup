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
  evaluateReaperFloor,
  executeReaps,
  managedResidueCandidates,
  readScopeHolder,
  REAP_MAX_PER_TICK,
  REAP_TERMINAL_GRACE_MS,
  residualAfterPass,
  rowOwnerId,
  type ManagedResidueCandidate,
  type ReapDecision,
  type ReaperFloorSample,
  type ReapOutcome,
  type ScopeHolder,
} from './reaper';
import type { CgroupFs } from './cgroup-read';
import type { ResidueGroup } from './reconcile';
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
    cgroupPath: `/user.slice/papercusp-agent-session.slice/pc-${partial.taskId}--test.scope`,
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
    logQuiet?: Record<string, number | null>;
    managedResidue?: ManagedResidueCandidate[];
    scopePids?: Record<string, number | null>;
    holders?: Record<string, ScopeHolder | 'unreadable'>;
    maxPerTick?: number;
  } = {},
) {
  return decideReaps({
    rows,
    census: census(rows, opts.mtimes ?? {}),
    scopePidCount: (r) => (opts.pids ? (r.taskId in opts.pids ? opts.pids[r.taskId] : 0) : 0),
    managedResidue: opts.managedResidue,
    scopePidCountForScope: (scopeUnit) => opts.scopePids?.[scopeUnit] ?? 0,
    scopeHolderForScope: (scopeUnit) => opts.holders?.[scopeUnit] ?? null,
    freshOwners: new Set(opts.freshOwners ?? []),
    logQuietForMs: (r) => opts.logQuiet?.[r.taskId] ?? null,
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

  it('spares a terminal row whose log is freshly written — a carry-respawn successor lives in the scope (CONTROL)', () => {
    const r = row({ taskId: 't5', state: 'exited', endedAt: new Date(NOW - HOUR).toISOString() });
    const v = decide([r], { pids: { t5: 6 }, logQuiet: { t5: 4 * 60_000 } });
    expect(v.reap).toHaveLength(0);
    expect(v.spared.some((s) => s.taskId === 't5' && /ANOMALY/.test(s.why))).toBe(true);
  });

  it('still reaps a terminal row whose log has been quiet well past the respawn guard (CAUGHT)', () => {
    const r = row({ taskId: 't6', state: 'exited', endedAt: new Date(NOW - HOUR).toISOString() });
    const v = decide([r], { pids: { t6: 6 }, logQuiet: { t6: 2 * HOUR } });
    expect(v.reap).toHaveLength(1);
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

  // The 2026-08-25 live 0/12 bug was "the operator's own pids were counted as a
  // dead session's survivors". It was first patched by FILTERING on cgroup_path
  // (leaf must equal scopeUnit); that filter is gone, because the field it trusts
  // is stale on ~30% of rows and the filter therefore also excluded genuine
  // residue — including a session log-silent 10h with no heartbeat.
  //
  // The hazard is now excluded STRUCTURALLY instead: pids are resolved from the
  // row's own scope unit, so a foreign cgroup_path has nothing to contribute.
  // These two cases pin that property rather than the old mechanism — if anyone
  // reintroduces a cgroup_path-derived filter or pid source, they fail.
  it('cgroup_path CANNOT influence the verdict — identical rows differing only in it decide identically', () => {
    const base = { state: 'ended_unobserved' as const, endedAt: new Date(NOW - HOUR).toISOString() };
    const correct = row({
      taskId: 'f1',
      ...base,
      cgroupPath: '/user.slice/papercusp-agent-session.slice/pc-f1--test.scope',
    });
    const stale = row({
      taskId: 'f2',
      ...base,
      // What the ledger actually recorded for 28 live rows whose processes were
      // in fact sitting in their own correct scopes.
      cgroupPath: '/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-dev-api.service',
    });
    const v = decide([correct, stale], { pids: { f1: 6, f2: 6 } });
    expect(v.reap.map((d) => d.taskId).sort()).toEqual(['f1', 'f2']);
  });

  it('a row whose OWN scope holds nothing is never reaped, however healthy its cgroup_path looks (CONTROL)', () => {
    // This is what actually spares the phantom rows: their scope does not exist,
    // so it reads a real zero and no stop is ever attempted against it.
    const r = row({
      taskId: 'f3',
      state: 'ended_unobserved',
      endedAt: new Date(NOW - HOUR).toISOString(),
    });
    const v = decide([r], { pids: { f3: 0 }, logQuiet: { f3: 23 * HOUR } });
    expect(v.reap).toHaveLength(0);
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

describe('managed no-row residue candidates', () => {
  const root = '/user.slice/user@1000.service/papercusp.slice/papercusp-agent.slice/papercusp-agent-session.slice';
  const scopeUnit = 'pc-missing123--fleet-member.scope';
  const group = (over: Partial<ResidueGroup>): ResidueGroup => ({
    cgroupPath: `${root}/${scopeUnit}`,
    scopeUnit,
    pids: [31],
    sampleCmdline: 'claude',
    ...over,
  });

  it('accepts only the exact managed agent-session hierarchy and merges leaf groups by scope', () => {
    const candidates = managedResidueCandidates([
      group({ cgroupPath: `${root}/${scopeUnit}/child-a`, pids: [31, 32] }),
      group({ cgroupPath: `${root}/${scopeUnit}/child-b`, pids: [32, 33], sampleCmdline: '' }),
      group({ cgroupPath: `/user.slice/papercusp.slice/papercusp-bash-job.slice/${scopeUnit}`, pids: [99] }),
      group({ scopeUnit: 'pc-missing123--fleet-member.service', cgroupPath: `${root}/pc-missing123--fleet-member.service` }),
    ]);
    expect(candidates).toEqual([
      {
        taskId: 'missing123',
        scopeUnit,
        cgroupPath: `${root}/${scopeUnit}/child-a`,
        pids: [31, 32, 33],
        sampleCmdline: 'claude',
      },
    ]);
  });

  it('requires a positive current scope recheck and skips a scope adopted by a row', () => {
    const candidate = managedResidueCandidates([group({})])[0]!;
    expect(decide([], { managedResidue: [candidate], scopePids: { [scopeUnit]: 0 } }).reap).toEqual([]);
    expect(
      decide([], { managedResidue: [candidate], scopePids: { [scopeUnit]: 4 } }).reap,
    ).toMatchObject([{ taskId: 'missing123', scopeUnit, kind: 'managed-residue' }]);
    expect(
      decide([row({ taskId: 'missing123', scopeUnit })], {
        managedResidue: [candidate],
        scopePids: { [scopeUnit]: 4 },
      }).reap,
    ).toEqual([]);
  });

  it('spares a no-row scope its live spawner still holds, and one whose holder is unmeasurable (CONTROL)', () => {
    const candidate = managedResidueCandidates([group({})])[0]!;
    const holder: ScopeHolder = { pid: 500, comm: 'node', cgroupPath: '/user.slice/app.slice/vitest.scope' };
    const held = decide([], { managedResidue: [candidate], scopePids: { [scopeUnit]: 4 }, holders: { [scopeUnit]: holder } });
    expect(held.reap).toEqual([]);
    expect(held.spared).toMatchObject([{ taskId: 'missing123', why: expect.stringContaining('live parent pid 500 (node)') }]);
    const unmeasured = decide([], {
      managedResidue: [candidate],
      scopePids: { [scopeUnit]: 4 },
      holders: { [scopeUnit]: 'unreadable' },
    });
    expect(unmeasured.reap).toEqual([]);
    expect(unmeasured.spared).toMatchObject([{ taskId: 'missing123', why: expect.stringContaining('unmeasurable') }]);
  });

  it('spares every no-row candidate when the caller supplies no holder probe', () => {
    const candidate = managedResidueCandidates([group({})])[0]!;
    const verdict = decideReaps({
      rows: [],
      census: census([], {}),
      scopePidCount: () => 0,
      managedResidue: [candidate],
      scopePidCountForScope: () => 4,
      freshOwners: new Set(),
      logQuietForMs: () => null,
      now: NOW,
    });
    expect(verdict.reap).toEqual([]);
  });
});

describe('readScopeHolder', () => {
  const userManager = '/user.slice/user-1000.slice/user@1000.service';
  const scopeUnit = 'pc-missing123--fleet-member.scope';
  const scope = `${userManager}/papercusp.slice/papercusp-agent.slice/papercusp-agent-session.slice/${scopeUnit}`;
  const proc = (files: Record<string, string>): CgroupFs => ({
    readFile: (path) => files[path] ?? null,
    readDir: () => [],
    isDir: () => false,
  });
  const member = (pid: number, ppid: number, cgroup = scope) => ({
    [`/proc/${pid}/cgroup`]: `0::${cgroup}\n`,
    [`/proc/${pid}/status`]: `Name:\tclaude\nUmask:\t0002\nPPid:\t${ppid}\nTracerPid:\t0\n`,
  });
  const other = (pid: number, cgroup: string, comm = 'node') => ({
    [`/proc/${pid}/cgroup`]: `0::${cgroup}\n`,
    [`/proc/${pid}/comm`]: `${comm}\n`,
  });

  it('names a live parent outside the scope: an isolated operator still owns its engine', () => {
    const fs = proc({ ...member(31, 500), ...other(500, `${userManager}/app.slice/pc-runner.scope`) });
    expect(readScopeHolder(scopeUnit, [31], fs)).toEqual({
      pid: 500,
      comm: 'node',
      cgroupPath: `${userManager}/app.slice/pc-runner.scope`,
    });
  });

  it('finds no holder once the spawner died and the subreaper adopted the scope (CAUGHT)', () => {
    expect(readScopeHolder(scopeUnit, [31], proc({ ...member(31, 900), ...other(900, `${userManager}/init.scope`, 'systemd') }))).toBeNull();
    expect(readScopeHolder(scopeUnit, [31], proc(member(31, 1)))).toBeNull();
    // A member parented inside the scope is not a holder, and the scope root is orphaned.
    const nested = proc({ ...member(31, 900), ...member(32, 31), ...other(900, `${userManager}/init.scope`, 'systemd') });
    expect(readScopeHolder(scopeUnit, [31, 32], nested)).toBeNull();
    // The parent exited between reads: its child is being reparented right now.
    expect(readScopeHolder(scopeUnit, [31], proc(member(31, 500)))).toBeNull();
  });

  it('never measures through a pid that left the scope, and reports an unreadable scope as such', () => {
    const recycled = proc({ ...member(31, 500, `${userManager}/app.slice/other.scope`), ...other(500, `${userManager}/app.slice/x.scope`) });
    expect(readScopeHolder(scopeUnit, [31], recycled)).toBe('unreadable');
    expect(readScopeHolder(scopeUnit, [31], proc({}))).toBe('unreadable');
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

  it('archives and stops managed no-row residue without closing a nonexistent ledger row', async () => {
    const calls: string[] = [];
    await executeReaps(
      [
        {
          taskId: 'missing123',
          scopeUnit: 'pc-missing123--fleet-member.scope',
          logPath: '/logs/missing123.log',
          kind: 'managed-residue',
          why: 'test',
        },
      ],
      {
        archiveTail: async () => (calls.push('archive'), '/arch/missing123.tail.log'),
        stopUnit: async () => (calls.push('stop'), true),
        closeAsReaped: async () => void calls.push('close'),
      },
    );
    expect(calls).toEqual(['archive', 'stop']);
  });
});

describe('addressability resolves from scopeUnit, never the ledger cgroup_path (WI-41607)', () => {
  // Mirrors production: pids are resolved by SCOPE UNIT against the real cgroup
  // tree, so a stale `cgroup_path` cannot influence the verdict either way.
  const byScope = (existing: Record<string, number>) => (r: TaskRow) =>
    r.scopeUnit && r.scopeUnit in existing ? existing[r.scopeUnit]! : 0;
  const emptyCensus = censusAgentSessionProgress([], { statMtimeMs: () => null });

  /** The ledger value measured on 27 live sessions whose processes were in fact
   *  in their own correct scopes — the field was simply stale. */
  const SPAWNER_CGROUP =
    '/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-bg-host.service';

  const terminalRow = (taskId: string) =>
    row({
      taskId,
      state: 'exited',
      endedAt: new Date(NOW - 30 * 60_000).toISOString(),
      cgroupPath: SPAWNER_CGROUP,
      logPath: null,
    });

  it('CAUGHT: reaps residue whose cgroup_path names the SPAWNER service, when the scope really exists', () => {
    const r = terminalRow('stale-path');
    const v = decideReaps({
      rows: [r],
      census: emptyCensus,
      scopePidCount: byScope({ [r.scopeUnit!]: 7 }),
      freshOwners: new Set(),
      logQuietForMs: () => null,
      now: NOW,
    });
    // Under the old cgroup_path leaf-match guard this row was skipped forever,
    // which is how a session log-silent for 10h with no heartbeat survived.
    expect(v.reap.map((d) => d.taskId)).toEqual(['stale-path']);
  });

  it('CONTROL: skips a PHANTOM row whose scope never existed — nothing is stopped', () => {
    const r = terminalRow('phantom');
    const v = decideReaps({
      rows: [r],
      census: emptyCensus,
      scopePidCount: byScope({}), // scope absent ⇒ a real zero
      freshOwners: new Set(),
      logQuietForMs: () => null,
      now: NOW,
    });
    // The 0/12 loop: 12 such rows were selected and their stops failed, every
    // 5 minutes for an hour. Selecting nothing is the fix, not failing quietly.
    expect(v.reap).toEqual([]);
  });

  it('CONTROL: an unreadable scope (null) is still never treated as "has processes"', () => {
    const r = terminalRow('unreadable');
    const v = decideReaps({
      rows: [r],
      census: emptyCensus,
      scopePidCount: () => null,
      freshOwners: new Set(),
      logQuietForMs: () => null,
      now: NOW,
    });
    expect(v.reap).toEqual([]);
  });
});

describe('the recurrence guard — residualAfterPass / evaluateReaperFloor (P-006)', () => {
  const outcome = (ok: boolean): ReapOutcome => ({
    taskId: 't',
    scopeUnit: 's',
    kind: 'terminal-residue',
    ok,
    archived: null,
  });
  /** Samples oldest→newest, one per pass. */
  const ring = (...counts: number[]): ReaperFloorSample[] =>
    counts.map((scopesDead, i) => ({ atMs: NOW - (counts.length - i) * 5 * 60_000, scopesDead }));

  it('counts attempted-but-FAILED stops as the residue that survived the pass', () => {
    expect(residualAfterPass([outcome(false), outcome(false), outcome(true)])).toBe(2);
  });

  it('does NOT count spared rows — sparing is the rails working, not a failure', () => {
    // A pass that spared a live successor and cleared everything it selected has
    // left nothing behind. Counting spares here would make correct caution
    // indistinguishable from broken enforcement and alarm forever on a healthy box.
    expect(residualAfterPass([outcome(true), outcome(true)])).toBe(0);
  });

  // ── CONTROL: throughput is not inability ───────────────────────────────────
  // A backlog wider than REAP_MAX_PER_TICK defers its remainder BY DESIGN and the
  // next pass takes the next batch. The alarm this feeds accuses the reaper of
  // "selecting scopes it cannot clear" — flatly untrue of a deferred scope, which
  // was never attempted. The first implementation added `deferred` in here, so any
  // healthy drain of 13+ scopes would have escalated on its third pass with that
  // false diagnosis. The signature no longer offers deferral a channel at all;
  // operators still see it in the pass line and the alarm body.
  it('CONTROL: a capped pass that cleared everything it ATTEMPTED leaves no residue, however much it deferred', () => {
    expect(residualAfterPass([outcome(true), outcome(true), outcome(true)])).toBe(0);
  });

  it('CAUGHT: deferral does not launder a failure — a capped pass whose stops failed is still residue', () => {
    expect(residualAfterPass([outcome(false), outcome(false)])).toBe(2);
  });

  // ── THE REGRESSION CASE ────────────────────────────────────────────────────
  // This is the exact shape of the 2026-08-25 incident: the reaper selected 12
  // terminal-residue scopes and failed all 12, every five minutes, for an hour.
  it('CAUGHT: fires on a FLAT non-zero floor — the shape a growth detector misses', () => {
    const flat = ring(12, 12, 12, 12);
    const v = evaluateReaperFloor(flat, {});
    expect(v.alarm).toBe(true);
    expect(v.kind).toBe('stuck');
    expect(v.consecutiveNonZero).toBe(4);

    // The control that justifies the design: this series has ZERO growth — its
    // floor is identical in every window — so an accumulation/trend detector
    // would report "steady" and stay silent through the whole outage.
    expect(Math.min(...flat.map((s) => s.scopesDead))).toBe(
      Math.max(...flat.map((s) => s.scopesDead)),
    );
  });

  it('CONTROL: a healthy reaper (every pass clears) never alarms', () => {
    const v = evaluateReaperFloor(ring(0, 0, 0, 0, 0), {});
    expect(v.alarm).toBe(false);
    expect(v.consecutiveNonZero).toBe(0);
  });

  it('CONTROL: a single pass that cleared resets the streak', () => {
    // 3 bad passes then a clean one: enforcement is working again, so an alarm
    // here would be a false positive that trains readers to ignore it.
    const v = evaluateReaperFloor(ring(9, 9, 9, 0), {});
    expect(v.alarm).toBe(false);
    expect(v.consecutiveNonZero).toBe(0);
  });

  it('CONTROL: two bad passes is not yet three', () => {
    expect(evaluateReaperFloor(ring(0, 4, 4), {}).alarm).toBe(false);
  });

  it('thin history is reported as NO VERDICT, never as healthy', () => {
    // An empty or unreadable ring must not read green — the store is best-effort
    // by contract and returns [] on failure.
    const v = evaluateReaperFloor(ring(1, 1), {});
    expect(v.alarm).toBe(false);
    expect(v.summary).toContain('not the same as healthy');
  });

  it('respects a tightened minConsecutive', () => {
    expect(evaluateReaperFloor(ring(0, 3, 3), { minConsecutive: 2 }).alarm).toBe(true);
  });
});
