import { describe, it, expect, vi } from 'vitest';
import {
  planIdleSessionReap,
  classifyLiveIdle,
  terminateIdleLiveSessions,
  planZombieReap,
  reapZombieResumeProcs,
  parseForegroundFromStat,
  IDLE_SESSION_GRACE_MS,
  IDLE_ACTIVITY_THRESHOLD_MS,
  type ReapableSession,
  type LiveIdleCandidate,
  type IdleLiveSession,
  type TerminateDeps,
  type ResumeProc,
  type ZombieReapDeps,
} from './idle-session-reaper';
import { FLAGS } from '@papercusp/flags';

const NOW = 1_000_000_000_000;
const old = (agoMs: number): number => NOW - agoMs;
const session = (id: number, coordOwnerId: string | null, startedAtMs: number): ReapableSession => ({
  id,
  coordOwnerId,
  startedAtMs,
});

describe('planIdleSessionReap (P-011 idle-session reaper — slice 1: dead-process ghosts)', () => {
  it('reaps an open session whose owner is dead (not protected) and past the grace floor', () => {
    const s = session(1, 'su-dead', old(2 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(), // owner not live → dead process
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([s]);
    expect(plan.keptLive).toHaveLength(0);
  });

  it('NEVER reaps a session whose owner is live/claim/wake-protected, however old', () => {
    const s = session(2, 'su-live', old(100 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(['su-live']),
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptLive).toEqual([s]);
  });

  it('NEVER reaps a brand-new session inside the grace floor (its first presence beat may not have landed)', () => {
    const s = session(3, 'su-new', old(IDLE_SESSION_GRACE_MS - 1));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(), // not yet present — but too new to judge
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptFresh).toEqual([s]);
  });

  it('NEVER reaps a session with no coord_owner_id (no liveness key to prove it dead)', () => {
    const s = session(4, null, old(100 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [s],
      protectedOwners: new Set(),
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptNoOwner).toEqual([s]);
  });

  it('grace boundary: just under the floor is kept-fresh; exactly at the floor is reapable (strict <)', () => {
    const justUnder = session(5, 'su-x', old(IDLE_SESSION_GRACE_MS - 1)); // delta < grace → fresh
    const atFloor = session(6, 'su-y', old(IDLE_SESSION_GRACE_MS)); // delta === grace, NOT < grace → reap
    const plan = planIdleSessionReap({
      sessions: [justUnder, atFloor],
      protectedOwners: new Set(),
      nowMs: NOW,
    });
    expect(plan.keptFresh).toEqual([justUnder]);
    expect(plan.reap).toEqual([atFloor]);
  });

  it('partitions a mixed batch correctly', () => {
    const dead = session(10, 'dead', old(5 * IDLE_SESSION_GRACE_MS));
    const live = session(11, 'live', old(5 * IDLE_SESSION_GRACE_MS));
    const fresh = session(12, 'fresh', old(60_000));
    const noOwner = session(13, null, old(5 * IDLE_SESSION_GRACE_MS));
    const plan = planIdleSessionReap({
      sessions: [dead, live, fresh, noOwner],
      protectedOwners: new Set(['live']),
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([dead]);
    expect(plan.keptLive).toEqual([live]);
    expect(plan.keptFresh).toEqual([fresh]);
    expect(plan.keptNoOwner).toEqual([noOwner]);
  });
});

describe('classifyLiveIdle (P-011 slice 2: live-but-idle detection — the D-007 cohort)', () => {
  const cand = (
    coordOwnerId: string,
    heartbeatAgoMs: number,
    lastActiveAgoMs: number | null,
  ): LiveIdleCandidate => ({
    coordOwnerId,
    heartbeatAtMs: NOW - heartbeatAgoMs,
    lastActiveAtMs: lastActiveAgoMs == null ? null : NOW - lastActiveAgoMs,
  });

  it('flags a session that is alive (fresh heartbeat) but idle (stale activity) and not busy', () => {
    const c = cand('su-idle', 30_000 /* alive */, 5 * 60 * 60 * 1000 /* 5h idle */);
    const out = classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW });
    expect(out).toEqual([c]);
  });

  it('does NOT flag a recently-active session', () => {
    const c = cand('su-active', 30_000, 60_000 /* active 1 min ago */);
    expect(classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW })).toHaveLength(0);
  });

  it('does NOT flag a DEAD-process session (stale heartbeat) — that is the dead-ghost reaper job', () => {
    const c = cand('su-dead', 5 * IDLE_SESSION_GRACE_MS /* heartbeat stale → dead */, 5 * 60 * 60 * 1000);
    expect(classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW })).toHaveLength(0);
  });

  it('does NOT flag an idle session whose owner is BUSY (holds a claim / wake / running bee)', () => {
    const c = cand('su-busy', 30_000, 5 * 60 * 60 * 1000);
    expect(
      classifyLiveIdle({ candidates: [c], busyOwners: new Set(['su-busy']), nowMs: NOW }),
    ).toHaveLength(0);
  });

  it('treats a null last_active_at as never-active → idle (when alive + not busy)', () => {
    const c = cand('su-never', 30_000, null);
    expect(classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW })).toEqual([c]);
  });

  it('idle boundary: just under the threshold is not idle; at/over it is', () => {
    const justUnder = cand('su-u', 30_000, IDLE_ACTIVITY_THRESHOLD_MS - 1);
    const atThreshold = cand('su-a', 30_000, IDLE_ACTIVITY_THRESHOLD_MS);
    const out = classifyLiveIdle({
      candidates: [justUnder, atThreshold],
      busyOwners: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([atThreshold]);
  });
});

describe('terminateIdleLiveSessions (P-011 slice 2 / WI-152: live-but-idle TERMINATION — write half)', () => {
  const idleSession = (advSessionId: number, coordOwnerId: string): IdleLiveSession => ({
    advSessionId,
    coordOwnerId,
    idleMs: 5 * 60 * 60 * 1000,
  });

  /** A deps harness whose side-effects are all spies — no real PG / pty / pid. */
  function makeDeps(over: {
    master?: boolean;
    terminate?: boolean;
    targets?: IdleLiveSession[];
    pidByOwner?: Record<string, number | null>;
    aliveByPid?: Record<number, boolean>;
    markEndedImpl?: (id: number) => Promise<void>;
    gracefulImpl?: (owner: string) => Promise<boolean>;
  }) {
    const calls = {
      graceful: [] as string[],
      sigkill: [] as number[],
      marked: [] as number[],
      listIdle: 0,
    };
    const deps: TerminateDeps = {
      isFlagOn: vi.fn(async (flag) => {
        if (flag === FLAGS.IDLE_SESSION_REAPER) return over.master ?? true;
        if (flag === FLAGS.IDLE_SESSION_REAPER_TERMINATE) return over.terminate ?? true;
        return false;
      }),
      listIdle: vi.fn(async () => {
        calls.listIdle += 1;
        return over.targets ?? [];
      }),
      gracefulInterrupt: vi.fn(async (owner: string) => {
        calls.graceful.push(owner);
        return over.gracefulImpl ? over.gracefulImpl(owner) : true;
      }),
      resolvePid: vi.fn((owner: string) => over.pidByOwner?.[owner] ?? 1234),
      pidAlive: vi.fn((pid: number) => over.aliveByPid?.[pid] ?? true),
      sigkill: vi.fn((pid: number) => {
        calls.sigkill.push(pid);
        return true;
      }),
      markEnded: vi.fn(async (id: number) => {
        calls.marked.push(id);
        if (over.markEndedImpl) await over.markEndedImpl(id);
      }),
      // Instant wait so the test never actually sleeps.
      wait: vi.fn(async () => {}),
    };
    return { deps, calls };
  }

  it('DOUBLE-GATE: no-op (no listIdle, no kills) unless BOTH flags are on', async () => {
    // master off
    {
      const { deps, calls } = makeDeps({ master: false, terminate: true, targets: [idleSession(1, 'su-a')] });
      const r = await terminateIdleLiveSessions({ deps });
      expect(r.enabled).toBe(false);
      expect(r.targeted).toBe(0);
      expect(calls.listIdle).toBe(0);
      expect(calls.graceful).toHaveLength(0);
      expect(calls.marked).toHaveLength(0);
    }
    // terminate off
    {
      const { deps, calls } = makeDeps({ master: true, terminate: false, targets: [idleSession(1, 'su-a')] });
      const r = await terminateIdleLiveSessions({ deps });
      expect(r.enabled).toBe(false);
      expect(calls.listIdle).toBe(0);
      expect(calls.marked).toHaveLength(0);
    }
    // both off
    {
      const { deps } = makeDeps({ master: false, terminate: false, targets: [idleSession(1, 'su-a')] });
      expect((await terminateIdleLiveSessions({ deps })).enabled).toBe(false);
    }
  });

  it('busy-owner exclusion: only the (already busy-filtered) listIdle targets are touched', async () => {
    // The busy/dead exclusion lives in findIdleLiveSessions/gatherBusyOwners; the
    // terminate sweep only ever acts on what listIdle hands it. A busy owner that
    // listIdle filters out is therefore never interrupted/killed/ended.
    const { deps, calls } = makeDeps({
      targets: [idleSession(10, 'su-idle')], // 'su-busy' deliberately NOT in the list
    });
    const r = await terminateIdleLiveSessions({ deps });
    expect(r.targeted).toBe(1);
    expect(r.terminated).toBe(1);
    expect(calls.graceful).toEqual(['su-idle']);
    expect(calls.marked).toEqual([10]);
    // never touched a non-targeted (busy) owner
    expect(calls.graceful).not.toContain('su-busy');
  });

  it('dryRun: counts the targets but makes NO kills and NO PG writes', async () => {
    const { deps, calls } = makeDeps({ targets: [idleSession(1, 'su-a'), idleSession(2, 'su-b')] });
    const r = await terminateIdleLiveSessions({ dryRun: true, deps });
    expect(r.dryRun).toBe(true);
    expect(r.targeted).toBe(2);
    expect(r.terminated).toBe(2);
    expect(r.terminatedIds).toEqual([1, 2]);
    expect(calls.graceful).toHaveLength(0); // no Ctrl-C
    expect(calls.sigkill).toHaveLength(0); // no SIGKILL
    expect(calls.marked).toHaveLength(0); // no PG write
  });

  it('successful termination: Ctrl-C → mark ended, SIGKILL only if still alive after grace', async () => {
    const { deps, calls } = makeDeps({
      targets: [idleSession(7, 'su-still-alive'), idleSession(8, 'su-exited')],
      pidByOwner: { 'su-still-alive': 100, 'su-exited': 200 },
      aliveByPid: { 100: true /* needs SIGKILL */, 200: false /* exited on Ctrl-C */ },
    });
    const r = await terminateIdleLiveSessions({ deps });
    expect(r.terminated).toBe(2);
    expect(r.terminatedIds).toEqual([7, 8]);
    expect(r.failed).toBe(0);
    expect(calls.graceful).toEqual(['su-still-alive', 'su-exited']);
    expect(calls.sigkill).toEqual([100]); // only the still-alive pid is SIGKILLed
    expect(calls.marked).toEqual([7, 8]); // both rows marked ended regardless
  });

  it('best-effort: a per-session failure is counted but does NOT break the sweep', async () => {
    // The failure path logs a non-fatal console.warn (production behavior); the
    // repo's vitest-fail-on-console requires it be mocked + asserted explicitly.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, calls } = makeDeps({
      targets: [idleSession(1, 'su-ok-1'), idleSession(2, 'su-boom'), idleSession(3, 'su-ok-2')],
      markEndedImpl: async (id) => {
        if (id === 2) throw new Error('PG write blew up');
      },
    });
    const r = await terminateIdleLiveSessions({ deps });
    expect(r.targeted).toBe(3);
    expect(r.terminated).toBe(2); // the two that succeeded
    expect(r.failed).toBe(1); // the one that threw
    expect(r.terminatedIds).toEqual([1, 3]);
    // the sweep kept going past the failure — the third owner was still interrupted
    expect(calls.graceful).toEqual(['su-ok-1', 'su-boom', 'su-ok-2']);
    expect(warn).toHaveBeenCalledTimes(1); // one per-session failure logged
    warn.mockRestore();
  });

  it('empty target list: enabled, zero work, no kills', async () => {
    const { deps, calls } = makeDeps({ targets: [] });
    const r = await terminateIdleLiveSessions({ deps });
    expect(r).toMatchObject({ enabled: true, targeted: 0, terminated: 0, failed: 0, terminatedIds: [] });
    expect(calls.graceful).toHaveLength(0);
    expect(calls.marked).toHaveLength(0);
  });
});

describe('planZombieReap (slice 3: ended-session zombie procs — EI-1873, pure)', () => {
  const p = (pid: number, sessionId: string): ResumeProc => ({ pid, sessionId });
  it('keeps ONLY procs whose session is in the ENDED set', () => {
    const procs = [p(1, 'sess-a'), p(2, 'sess-b'), p(3, 'sess-c')];
    expect(planZombieReap(procs, new Set(['sess-a', 'sess-c'])).map((z) => z.pid)).toEqual([1, 3]);
  });
  it('empty ended set → no zombies (an OPEN session is never a zombie)', () => {
    expect(planZombieReap([p(1, 'sess-a')], new Set())).toEqual([]);
  });
  it('two procs sharing one ended session are BOTH zombies (the dup-proc leak)', () => {
    expect(planZombieReap([p(1, 'x'), p(2, 'x')], new Set(['x'])).map((z) => z.pid)).toEqual([1, 2]);
  });
});

describe('reapZombieResumeProcs (slice 3: zombie-proc sweep — EI-1873, write half)', () => {
  const p = (pid: number, sessionId: string): ResumeProc => ({ pid, sessionId });
  function makeDeps(over: {
    master?: boolean;
    terminate?: boolean;
    procs?: ResumeProc[];
    ended?: string[];
    aliveByPid?: Record<number, boolean>;
    stillByPid?: Record<number, boolean>;
  }) {
    const calls = { listed: 0, endedQ: [] as string[][], sigterm: [] as number[], sigkill: [] as number[] };
    const deps: ZombieReapDeps = {
      isFlagOn: vi.fn(async (flag) => {
        if (flag === FLAGS.IDLE_SESSION_REAPER) return over.master ?? true;
        if (flag === FLAGS.IDLE_SESSION_REAPER_TERMINATE) return over.terminate ?? true;
        return false;
      }),
      listResumeProcs: vi.fn(async () => { calls.listed += 1; return over.procs ?? []; }),
      endedSessionIds: vi.fn(async (ids: string[]) => { calls.endedQ.push(ids); return new Set(over.ended ?? []); }),
      sigterm: vi.fn((pid: number) => { calls.sigterm.push(pid); return true; }),
      pidAlive: vi.fn((pid: number) => over.aliveByPid?.[pid] ?? false),
      sigkill: vi.fn((pid: number) => { calls.sigkill.push(pid); return true; }),
      stillTheProc: vi.fn(async (pid: number) => over.stillByPid?.[pid] ?? true),
      wait: vi.fn(async () => {}),
    };
    return { deps, calls };
  }

  it('DOUBLE-GATE: no-op (no proc scan, no kills) unless BOTH flags are on', async () => {
    for (const [m, tn] of [[false, true], [true, false], [false, false]] as const) {
      const { deps, calls } = makeDeps({ master: m, terminate: tn, procs: [p(1, 'a')], ended: ['a'] });
      const r = await reapZombieResumeProcs({ deps });
      expect(r.enabled).toBe(false);
      expect(calls.listed).toBe(0);
      expect(calls.sigterm).toHaveLength(0);
    }
  });

  it('kills ONLY the ended-session procs; spares an open-session proc', async () => {
    const { deps, calls } = makeDeps({
      procs: [p(11, 'ended-x'), p(22, 'open-y')],
      ended: ['ended-x'],
      aliveByPid: { 11: false }, // exits on SIGTERM
    });
    const r = await reapZombieResumeProcs({ deps });
    expect(r).toMatchObject({ enabled: true, scannedProcs: 2, zombies: 1, killedPids: [11] });
    expect(calls.sigterm).toEqual([11]); // never 22 (open session)
    expect(calls.sigkill).toHaveLength(0); // exited on TERM
  });

  it('SIGKILLs a survivor (still alive after TERM) after re-verifying the cmdline', async () => {
    const { deps, calls } = makeDeps({ procs: [p(33, 'z')], ended: ['z'], aliveByPid: { 33: true }, stillByPid: { 33: true } });
    await reapZombieResumeProcs({ deps });
    expect(calls.sigterm).toEqual([33]);
    expect(calls.sigkill).toEqual([33]);
  });

  it('PID-recycle guard: a pid whose cmdline no longer matches is NEVER signalled', async () => {
    const { deps, calls } = makeDeps({ procs: [p(44, 'z')], ended: ['z'], stillByPid: { 44: false } });
    const r = await reapZombieResumeProcs({ deps });
    expect(calls.sigterm).toHaveLength(0);
    expect(calls.sigkill).toHaveLength(0);
    expect(r.killedPids).toEqual([]);
  });

  it('dryRun: reports the zombies but sends NO signals', async () => {
    const { deps, calls } = makeDeps({ procs: [p(1, 'a'), p(2, 'b')], ended: ['a', 'b'] });
    const r = await reapZombieResumeProcs({ deps, dryRun: true });
    expect(r).toMatchObject({ enabled: true, scannedProcs: 2, zombies: 2, dryRun: true, killedPids: [1, 2] });
    expect(calls.sigterm).toHaveLength(0);
    expect(calls.sigkill).toHaveLength(0);
  });

  it('dedups the session-id query input (two procs, one ended session → both zombies)', async () => {
    const { deps, calls } = makeDeps({ procs: [p(1, 'x'), p(2, 'x')], ended: ['x'], aliveByPid: { 1: false, 2: false } });
    const r = await reapZombieResumeProcs({ deps });
    expect(calls.endedQ[0]).toEqual(['x']); // queried once, deduped
    expect(r.zombies).toBe(2);
  });
});

describe('parseForegroundFromStat (slice 3: foreground/TTY spare — EI-1873 collateral guard)', () => {
  // /proc/<pid>/stat: pid (comm) state ppid pgrp session tty_nr tpgid ...
  const stat = (pgrp: number, ttyNr: number, tpgid: number, comm = 'claude') =>
    `12345 (${comm}) S 1 ${pgrp} 1 ${ttyNr} ${tpgid} 4194304 0 0 0`;

  it('FOREGROUND (live interactive, ps `+`): controlling tty AND pgrp owns it → true (SPARED)', () => {
    expect(parseForegroundFromStat(stat(469879, 34882, 469879))).toBe(true);
  });
  it('no controlling tty (tty_nr=0) → false (a backgrounded leaked proc → reapable)', () => {
    expect(parseForegroundFromStat(stat(200, 0, -1))).toBe(false);
  });
  it('tty but NOT the foreground group (pgrp≠tpgid) → false (background of its tty → reapable)', () => {
    expect(parseForegroundFromStat(stat(200, 34882, 999))).toBe(false);
  });
  it('comm containing spaces/parens: lastIndexOf(")") slices correctly → still parses foreground', () => {
    expect(parseForegroundFromStat(stat(200, 34882, 200, 'claude (worker)'))).toBe(true);
    expect(parseForegroundFromStat(stat(200, 0, -1, 'claude --resume'))).toBe(false);
  });
  it('malformed/short line → false (NaN guard; never over-spare on garbage)', () => {
    expect(parseForegroundFromStat('12345 (claude) S')).toBe(false);
    expect(parseForegroundFromStat('')).toBe(false);
  });
});
