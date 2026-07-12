import { describe, it, expect, vi } from 'vitest';
import {
  planIdleSessionReap,
  planWindowUnknownProtection,
  planWorkItemLeaseReap,
  classifyLiveIdle,
  terminateIdleLiveSessions,
  planZombieReap,
  reapZombieResumeProcs,
  planDeadAwaitReclaim,
  liveHostOwnerSet,
  resumableOpenSessionOwners,
  parseForegroundFromStat,
  IDLE_SESSION_GRACE_MS,
  IDLE_ACTIVITY_THRESHOLD_MS,
  type ReapableSession,
  type WorkItemLeaseRow,
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
const lease = (id: string, takenBy: string, takenAtMs: number | null, harness: string | null = 'papercusp'): WorkItemLeaseRow => ({
  id,
  harness,
  takenBy,
  takenAtMs,
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

describe('planWorkItemLeaseReap (session-death-claim-release-2026-07-11 P-001 — slice 1b: dead-owner leases)', () => {
  it('force-releases a lease held by a dead owner past the grace floor', () => {
    const l = lease('WI-1', 'su-dead', old(2 * IDLE_SESSION_GRACE_MS));
    const plan = planWorkItemLeaseReap({
      leases: [l],
      liveOwners: new Set(), // owner not live → dead
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([l]);
    expect(plan.keptLive).toHaveLength(0);
  });

  it('NEVER releases a lease whose owner is live (heartbeat / on-desktop / viewer / host), however old', () => {
    const l = lease('WI-2', 'su-live', old(100 * IDLE_SESSION_GRACE_MS));
    const plan = planWorkItemLeaseReap({
      leases: [l],
      liveOwners: new Set(['su-live']),
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptLive).toEqual([l]);
  });

  it('NEVER releases a lease claimed within the grace floor (holder just claimed it; first heartbeat may not have landed)', () => {
    const l = lease('WI-3', 'su-new', old(IDLE_SESSION_GRACE_MS - 1));
    const plan = planWorkItemLeaseReap({
      leases: [l],
      liveOwners: new Set(),
      nowMs: NOW,
    });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keptFresh).toEqual([l]);
  });

  it('a lease with no takenAtMs (should not happen in practice) is treated as past-grace, not protected forever', () => {
    const l = lease('WI-4', 'su-dead', null);
    const plan = planWorkItemLeaseReap({
      leases: [l],
      liveOwners: new Set(),
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([l]);
  });

  it('a claim ALONE never counts as liveness — a dead owner holding a lease is still reaped (EI-9807/WI-4070 shape)', () => {
    // liveOwners here must have been computed with includeClaimHolders:false —
    // this test asserts the PURE decision honors whatever set it's given; the
    // "a claim can't protect itself" property is enforced by the caller
    // (runWorkItemLeaseReap) passing that set, exercised separately.
    const l = lease('WI-4070', 'su-killed', old(5 * IDLE_SESSION_GRACE_MS));
    const plan = planWorkItemLeaseReap({
      leases: [l],
      liveOwners: new Set(), // su-killed has NO fresh heartbeat / bee / wake / host
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([l]);
  });

  it('partitions a mixed batch of leases correctly', () => {
    const dead = lease('WI-10', 'dead', old(5 * IDLE_SESSION_GRACE_MS));
    const live = lease('WI-11', 'live', old(5 * IDLE_SESSION_GRACE_MS));
    const fresh = lease('WI-12', 'fresh-owner', old(60_000));
    const plan = planWorkItemLeaseReap({
      leases: [dead, live, fresh],
      liveOwners: new Set(['live']),
      nowMs: NOW,
    });
    expect(plan.reap).toEqual([dead]);
    expect(plan.keptLive).toEqual([live]);
    expect(plan.keptFresh).toEqual([fresh]);
  });
});

describe('planWindowUnknownProtection (WI-1967 — Windows conservative-on-stale, pure)', () => {
  const grace = IDLE_SESSION_GRACE_MS;

  it('is a no-op when the window signal is KNOWN (Linux/mac / fresh cache) — never over-protects', () => {
    const r = planWindowUnknownProtection({
      sessions: [session(1, 'a', old(2 * grace)), session(2, 'b', old(2 * grace))],
      windowSignalUnknown: false,
      alreadyProtected: new Set(),
      nowMs: NOW,
    });
    expect(r.extraProtectedOwners).toEqual([]);
    expect(r.keptWindowSignalUnknown).toBe(0);
  });

  it('protects EVERY open owner when unknown, but counts only past-grace + not-already-protected as rescued', () => {
    const sessions = [
      session(1, 'dead-old', old(2 * grace)), // reapable → rescued + protected
      session(2, 'live', old(2 * grace)), // already protected → protected (idempotent), NOT counted
      session(3, 'fresh', old(grace - 1)), // within grace → protected, NOT counted (never at risk)
      session(4, null, old(2 * grace)), // no owner → planIdleSessionReap never reaps → neither protected nor counted
    ];
    const r = planWindowUnknownProtection({
      sessions,
      windowSignalUnknown: true,
      alreadyProtected: new Set(['live']),
      nowMs: NOW,
    });
    expect(new Set(r.extraProtectedOwners)).toEqual(new Set(['dead-old', 'live', 'fresh']));
    expect(r.keptWindowSignalUnknown).toBe(1); // only 'dead-old' was actually saved from a reap
  });

  it('feeding the extra owners into planIdleSessionReap yields ZERO reaps (the end-to-end invariant)', () => {
    const sessions = [session(1, 'ghost-1', old(3 * grace)), session(2, 'ghost-2', old(5 * grace))];
    const protectedOwners = new Set<string>();
    const { extraProtectedOwners } = planWindowUnknownProtection({
      sessions,
      windowSignalUnknown: true,
      alreadyProtected: protectedOwners,
      nowMs: NOW,
    });
    for (const o of extraProtectedOwners) protectedOwners.add(o);
    const plan = planIdleSessionReap({ sessions, protectedOwners, nowMs: NOW });
    expect(plan.reap).toHaveLength(0); // nothing reaped while the window signal is unknown
    expect(plan.keptLive).toHaveLength(2);
  });

  it('counts two ghost rows sharing one dead owner as two sessions spared, deduping the owner for protection', () => {
    const r = planWindowUnknownProtection({
      sessions: [session(1, 'ghost', old(2 * grace)), session(2, 'ghost', old(3 * grace))],
      windowSignalUnknown: true,
      alreadyProtected: new Set(),
      nowMs: NOW,
    });
    expect(r.extraProtectedOwners).toEqual(['ghost']); // owner deduped
    expect(r.keptWindowSignalUnknown).toBe(2); // but 2 sessions saved
  });
});

describe('classifyLiveIdle (P-011 slice 2: live-but-idle detection — the D-007 cohort)', () => {
  // NB: the live-idle TERMINATION cohort is AUTO-kind (bee) sessions only — P-001/
  // D-001 excludes owner-directed (responsive) su/sentinel/planner from this sweep
  // (it Ctrl-C's + SIGKILLs its targets), so these generic cases use roleless
  // `s-…` ids (→ bee/auto). The responsive exclusion has its own cases below.
  const cand = (
    coordOwnerId: string,
    heartbeatAgoMs: number,
    lastActiveAgoMs: number | null,
    role: string | null = null,
  ): LiveIdleCandidate => ({
    coordOwnerId,
    heartbeatAtMs: NOW - heartbeatAgoMs,
    lastActiveAtMs: lastActiveAgoMs == null ? null : NOW - lastActiveAgoMs,
    role,
  });

  it('flags a session that is alive (fresh heartbeat) but idle (stale activity) and not busy', () => {
    const c = cand('s-idle', 30_000 /* alive */, 5 * 60 * 60 * 1000 /* 5h idle */);
    const out = classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW });
    expect(out).toEqual([c]);
  });

  it('does NOT flag a recently-active session', () => {
    const c = cand('s-active', 30_000, 60_000 /* active 1 min ago */);
    expect(classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW })).toHaveLength(0);
  });

  it('does NOT flag a DEAD-process session (stale heartbeat) — that is the dead-ghost reaper job', () => {
    const c = cand('s-dead', 5 * IDLE_SESSION_GRACE_MS /* heartbeat stale → dead */, 5 * 60 * 60 * 1000);
    expect(classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW })).toHaveLength(0);
  });

  it('does NOT flag an idle session whose owner is BUSY (holds a claim / wake / running bee)', () => {
    const c = cand('s-busy', 30_000, 5 * 60 * 60 * 1000);
    expect(
      classifyLiveIdle({ candidates: [c], busyOwners: new Set(['s-busy']), nowMs: NOW }),
    ).toHaveLength(0);
  });

  it('treats a null last_active_at as never-active → idle (when alive + not busy)', () => {
    const c = cand('s-never', 30_000, null);
    expect(classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW })).toEqual([c]);
  });

  it('idle boundary: just under the threshold is not idle; at/over it is', () => {
    const justUnder = cand('s-u', 30_000, IDLE_ACTIVITY_THRESHOLD_MS - 1);
    const atThreshold = cand('s-a', 30_000, IDLE_ACTIVITY_THRESHOLD_MS);
    const out = classifyLiveIdle({
      candidates: [justUnder, atThreshold],
      busyOwners: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([atThreshold]);
  });

  // ── P-001 / D-001: owner-directed (responsive) sessions are NEVER live-terminated ──
  it('does NOT flag an owner-directed su session (roleless su-… id) even when idle + alive + not busy', () => {
    const c = cand('su-173cbb09-c016-4d62-8806-70487830c24f', 30_000, 5 * 60 * 60 * 1000);
    expect(classifyLiveIdle({ candidates: [c], busyOwners: new Set(), nowMs: NOW })).toHaveLength(0);
  });

  it('does NOT flag sentinel (operator) / planner sessions by presence agentRole', () => {
    const op = cand('s-op', 30_000, 5 * 60 * 60 * 1000, 'operator');
    const pl = cand('s-pl', 30_000, 5 * 60 * 60 * 1000, 'planner');
    const bee = cand('s-bee', 30_000, 5 * 60 * 60 * 1000, 'worker');
    const out = classifyLiveIdle({ candidates: [op, pl, bee], busyOwners: new Set(), nowMs: NOW });
    // Only the auto-kind bee remains terminable; the two responsive sessions are excluded.
    expect(out).toEqual([bee]);
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
  it('SPARES an ended-session proc whose session is on the desktop (a live OS window)', () => {
    const procs = [p(1, 'sess-a'), p(2, 'sess-b')];
    // both sessions ended, but sess-b currently has an open OS window → not a zombie.
    expect(
      planZombieReap(procs, new Set(['sess-a', 'sess-b']), new Set(['sess-b'])).map((z) => z.pid),
    ).toEqual([1]);
  });
  it('the on-desktop set defaults empty (2-arg callers unchanged)', () => {
    expect(planZombieReap([p(1, 'x')], new Set(['x'])).map((z) => z.pid)).toEqual([1]);
  });
});

describe('reapZombieResumeProcs (slice 3: zombie-proc sweep — EI-1873, write half)', () => {
  const p = (pid: number, sessionId: string): ResumeProc => ({ pid, sessionId });
  function makeDeps(over: {
    master?: boolean;
    terminate?: boolean;
    procs?: ResumeProc[];
    ended?: string[];
    onDesktop?: string[];
    /** Pids whose /proc ancestry sits under an open window (WI-1586 spare). */
    desktopPids?: number[];
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
      onDesktopSessionIds: vi.fn(async () => new Set(over.onDesktop ?? [])),
      sigterm: vi.fn((pid: number) => { calls.sigterm.push(pid); return true; }),
      pidAlive: vi.fn((pid: number) => over.aliveByPid?.[pid] ?? false),
      sigkill: vi.fn((pid: number) => { calls.sigkill.push(pid); return true; }),
      stillTheProc: vi.fn(async (pid: number) => over.stillByPid?.[pid] ?? true),
      pidOnDesktop: vi.fn(async (pid: number) => (over.desktopPids ?? []).includes(pid)),
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

  it('SPARES an ended-session proc that is on the desktop (a live OS window), kills the rest', async () => {
    const { deps, calls } = makeDeps({
      procs: [p(11, 'ended-x'), p(22, 'ended-desktop')],
      ended: ['ended-x', 'ended-desktop'],
      onDesktop: ['ended-desktop'], // has a live OS window → never killed
      aliveByPid: { 11: false },
    });
    const r = await reapZombieResumeProcs({ deps });
    expect(r).toMatchObject({ enabled: true, scannedProcs: 2, zombies: 1, killedPids: [11] });
    expect(calls.sigterm).toEqual([11]); // never 22 (on the desktop)
  });

  it('SPARES a zombie whose PID sits under an open window (WI-1586 ancestry spare) — even with NO sessionId handle', async () => {
    // The regression shape: adv row carries no window_id/pid (capture rotted), so
    // the sessionId-keyed onDesktop spare misses it — the live /proc-ancestry
    // check must still refuse to signal a proc inside an open terminal window.
    const { deps, calls } = makeDeps({
      procs: [p(11, 'ended-x'), p(22, 'ended-in-window')],
      ended: ['ended-x', 'ended-in-window'],
      onDesktop: [], // handle-based spare BLIND (no captured window_id/pid)
      desktopPids: [22], // …but the proc's ancestry reaches a window-owning pid
      aliveByPid: { 11: false },
    });
    const r = await reapZombieResumeProcs({ deps });
    expect(calls.sigterm).toEqual([11]); // never 22
    expect(calls.sigkill).toHaveLength(0);
    expect(r.killedPids).toEqual([11]);
  });

  it('dryRun also honors the ancestry spare (a plan never lists a kill the real run would refuse)', async () => {
    const { deps, calls } = makeDeps({
      procs: [p(1, 'a'), p(2, 'b')],
      ended: ['a', 'b'],
      desktopPids: [2],
    });
    const r = await reapZombieResumeProcs({ deps, dryRun: true });
    expect(r.killedPids).toEqual([1]);
    expect(calls.sigterm).toHaveLength(0);
    expect(calls.sigkill).toHaveLength(0);
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

describe('planDeadAwaitReclaim (slice 4: reclaim-lane — dangling inbox-wake awaits, P-004)', () => {
  it('cancels awaits of owners NOT in the live-or-resumable set', () => {
    const dead = planDeadAwaitReclaim({
      awaitOwners: ['su-live', 'su-parked', 'su-ghost-1', 'su-ghost-2'],
      liveOrResumable: new Set(['su-live', 'su-parked']),
    });
    expect(dead.sort()).toEqual(['su-ghost-1', 'su-ghost-2']);
  });

  it('a PARKED-but-resumable owner (open adv_session + LIVE psu-host ⇒ in the live set) keeps its await', () => {
    // WI-2858: su-parked has no fresh heartbeat but an OPEN adv_session whose owner
    // has a LIVE psu-host → gatherLiveOrResumableOwners keeps it in liveOrResumable.
    const dead = planDeadAwaitReclaim({
      awaitOwners: ['su-parked', 'su-dead'],
      liveOrResumable: new Set(['su-parked']),
    });
    expect(dead).toEqual(['su-dead']); // only the genuinely-dead one
  });

  it('every owner alive/resumable ⇒ nothing cancelled (no false reclaim)', () => {
    expect(
      planDeadAwaitReclaim({
        awaitOwners: ['a', 'b', 'c'],
        liveOrResumable: new Set(['a', 'b', 'c']),
      }),
    ).toEqual([]);
  });

  it('dedupes repeated owners and drops empty ids', () => {
    const dead = planDeadAwaitReclaim({
      awaitOwners: ['su-ghost', 'su-ghost', '', 'su-ghost'],
      liveOrResumable: new Set(),
    });
    expect(dead).toEqual(['su-ghost']);
  });

  it('empty await set ⇒ nothing to do', () => {
    expect(planDeadAwaitReclaim({ awaitOwners: [], liveOrResumable: new Set(['x']) })).toEqual([]);
  });
});

describe('liveHostOwnerSet (WI-2858: map live psu-hosts → protected coord owners)', () => {
  it('collects each live host owner id, dropping null/empty', () => {
    const set = liveHostOwnerSet([
      { ownerId: 'su-a' },
      { ownerId: 'su-b' },
      { ownerId: '' }, // never-launched / partial file → not an owner
      { ownerId: null },
      {}, // no ownerId field
    ]);
    expect(set).toEqual(new Set(['su-a', 'su-b']));
  });

  it('empty host list ⇒ empty set (headless box / no discovery dir → host-liveness protects nobody)', () => {
    expect(liveHostOwnerSet([])).toEqual(new Set());
  });

  it('dedupes two hosts recorded for the same owner', () => {
    expect(liveHostOwnerSet([{ ownerId: 'su-x' }, { ownerId: 'su-x' }])).toEqual(new Set(['su-x']));
  });
});

describe('resumableOpenSessionOwners (WI-2858: an OPEN adv_session is resumable only WITH a live host)', () => {
  it('keeps an open-adv-session owner that HAS a live host', () => {
    expect(resumableOpenSessionOwners(['su-cold'], new Set(['su-cold']))).toEqual(['su-cold']);
  });

  it('DROPS an open-adv-session owner with NO live host (the SIGKILLed-ghost case — its await is reclaimable)', () => {
    expect(resumableOpenSessionOwners(['su-zombie'], new Set())).toEqual([]);
  });

  it('partitions a mixed batch: only the host-backed owners are resumable', () => {
    const out = resumableOpenSessionOwners(['su-cold', 'su-zombie', 'su-other'], new Set(['su-cold', 'su-unrelated']));
    expect(out).toEqual(['su-cold']);
  });

  it('dedupes repeated owners and drops empty ids', () => {
    expect(resumableOpenSessionOwners(['su-cold', 'su-cold', ''], new Set(['su-cold']))).toEqual(['su-cold']);
  });
});

describe('WI-2858 deadlock break — end-to-end at the pure boundary (slice-1 reap ⋈ slice-4 reclaim)', () => {
  // The exact invariant WI-2858 asks for: a stale-heartbeat + no-live-host +
  // dangling-await owner (a SIGKILLed desktop-restart ghost) is BOTH reaped by
  // slice-1 AND has its await reclaimed by slice-4, while a session spared by
  // EITHER a fresh heartbeat OR a live psu-host survives both. This composes the
  // real host-liveness helpers (liveHostOwnerSet / resumableOpenSessionOwners) with
  // the real plan functions, mimicking how the fixed gather functions build the sets.
  const OLD = 5 * IDLE_SESSION_GRACE_MS; // all three sessions are well past the grace floor

  // Three owners, each with an open adv_session AND a standing (dangling) inbox-wake await:
  //   su-zombie — SIGKILLed: stale heartbeat, NO live host        → must be reaped + reclaimed
  //   su-cold   — cold-parked: stale heartbeat, LIVE psu-host      → spared (host can relaunch)
  //   su-warm   — alive: FRESH heartbeat, no host needed           → spared (heartbeat)
  const freshHeartbeatOwners = new Set(['su-warm']); // the coord_presence fresh leg
  const liveHostOwners = liveHostOwnerSet([{ ownerId: 'su-cold' }]); // listLiveHosts() → owners
  const openAdvSessionOwners = ['su-zombie', 'su-cold', 'su-warm'];
  const danglingAwaitOwners = ['su-zombie', 'su-cold', 'su-warm'];

  it('slice-1: reaps ONLY the SIGKILLed ghost; the live-host and fresh-heartbeat owners are protected', () => {
    // Mimic the fixed gatherProtectedSessionOwners: fresh-heartbeat ∪ live-host.
    const protectedOwners = new Set([...freshHeartbeatOwners, ...liveHostOwners]);
    const sessions = [
      session(1, 'su-zombie', old(OLD)),
      session(2, 'su-cold', old(OLD)),
      session(3, 'su-warm', old(OLD)),
    ];
    const plan = planIdleSessionReap({ sessions, protectedOwners, nowMs: NOW });
    expect(plan.reap.map((s) => s.coordOwnerId)).toEqual(['su-zombie']);
    expect(new Set(plan.keptLive.map((s) => s.coordOwnerId))).toEqual(new Set(['su-cold', 'su-warm']));
  });

  it('slice-4: reclaims ONLY the SIGKILLed ghost’s await; the live-host and fresh-heartbeat awaits are preserved', () => {
    // Mimic the fixed gatherLiveOrResumableOwners: fresh-heartbeat ∪ (open-adv ∩ live-host).
    const liveOrResumable = new Set([
      ...freshHeartbeatOwners,
      ...resumableOpenSessionOwners(openAdvSessionOwners, liveHostOwners),
    ]);
    const dead = planDeadAwaitReclaim({ awaitOwners: danglingAwaitOwners, liveOrResumable });
    expect(dead).toEqual(['su-zombie']); // only the ghost — su-cold (host) + su-warm (heartbeat) keep their awaits
  });
});
