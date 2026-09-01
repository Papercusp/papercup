/**
 * Tests for silent-halt-reconcile (WI-35718).
 *
 * The load-bearing test in this file is INCIDENT ANCHOR (the fifth term). Everything else guards
 * an exemption; that one guards the difference between a detector and a 4,037-page metronome.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateSilentHalt,
  sweepSilentHalts,
  SILENT_HALT_MIN_STALE_MS,
  SILENT_HALT_HEARTBEAT_FRESH_MS,
  SILENT_HALT_MAX_PAGES_PER_SWEEP,
  type SilentHaltCandidate,
} from './silent-halt-reconcile';

const MIN = 60 * 1000;

/** A genuinely halted session: alive, autonomous, loop off, no wake source, long silent. */
function haltedInput(over: Partial<Parameters<typeof evaluateSilentHalt>[0]> = {}) {
  return {
    loopActive: false,
    hasPosture: true,
    pendingAwaits: 0,
    heartbeatAgeMs: 30 * 1000,
    lastRealTurnAgeMs: 120 * MIN,
    inactiveForMs: 120 * MIN,
    intervalSec: 60,
    ...over,
  };
}

describe('evaluateSilentHalt', () => {
  it('flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn', () => {
    const v = evaluateSilentHalt(haltedInput());
    expect(v.halted).toBe(true);
    expect(v.exemption).toBeNull();
    expect(v.reason).toMatch(/loop INACTIVE/);
  });

  it('INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted', () => {
    // THE FIFTH TERM, and the reason this module is not a metronome. Measured live before this
    // file existed: the conjunction WI-35718 specifies (posture + inactive loop + no pending
    // await) selects 4,037 rows in this workspace, of which 4,091 candidates have no presence
    // row at all — a cleanly-ended session leaves a mode row beside an inactive loop FOREVER,
    // and that residue is indistinguishable from a halt without liveness. Adding the presence
    // join collapsed 4,037 -> 67. If this test ever fails, the sweep has reverted to paging the
    // owner about every session that ever ended.
    const v = evaluateSilentHalt(haltedInput({ heartbeatAgeMs: null }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/no-presence-row/);
  });

  it('a stale heartbeat means the process is gone, not halted', () => {
    const v = evaluateSilentHalt(haltedInput({ heartbeatAgeMs: SILENT_HALT_HEARTBEAT_FRESH_MS + MIN }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/heartbeat-stale/);
  });

  it('a pending await IS a wake source — the 67 -> 3 collapse', () => {
    // 63 of 67 live candidates were exempt here at authoring time. This term, not liveness, is
    // what separates a WAITING agent from a halted one.
    const v = evaluateSilentHalt(haltedInput({ pendingAwaits: 1 }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/pending-await/);
  });

  it('an ARMED loop belongs to stalled-loops-guard, never this module', () => {
    const v = evaluateSilentHalt(haltedInput({ loopActive: true }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/loop-armed/);
  });

  it('a session with no autonomy posture has a human in front of it', () => {
    const v = evaluateSilentHalt(haltedInput({ hasPosture: false }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/no-autonomy-posture/);
  });

  it('does not page a loop disarmed seconds ago — most disarms self-heal', () => {
    const v = evaluateSilentHalt(haltedInput({ inactiveForMs: 2 * MIN }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/recently-disarmed/);
  });

  it('does not page an agent that produced a turn inside the floor', () => {
    const v = evaluateSilentHalt(haltedInput({ lastRealTurnAgeMs: 2 * MIN }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/recent-turn/);
  });

  it('fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)', () => {
    // Without a clock there is no evidence of a HALT as opposed to a session that has not
    // started yet, and an assertion the data cannot support must not become a page.
    const v = evaluateSilentHalt(haltedInput({ lastRealTurnAgeMs: null, inactiveForMs: null }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/no-duration-evidence/);
  });

  it('still flags a halt when the agent never produced a turn but the disarm clock is old', () => {
    const v = evaluateSilentHalt(haltedInput({ lastRealTurnAgeMs: null, inactiveForMs: 200 * MIN }));
    expect(v.halted).toBe(true);
    expect(v.reason).toMatch(/no real turn ever recorded/);
  });

  it('scales the staleness floor with the loop interval, never below the 30m floor', () => {
    // A 60s loop: 5 intervals = 5m, so the 30m floor binds.
    expect(evaluateSilentHalt(haltedInput({ intervalSec: 60 })).staleFloorMs).toBe(SILENT_HALT_MIN_STALE_MS);
    // A 1h loop: 5 intervals = 5h, which now binds instead.
    const slow = evaluateSilentHalt(haltedInput({ intervalSec: 3600, inactiveForMs: 60 * MIN, lastRealTurnAgeMs: 60 * MIN }));
    expect(slow.staleFloorMs).toBe(5 * 3600 * 1000);
    expect(slow.halted).toBe(false); // 60m is inside a 5h floor
  });
});

/** Build a sweep whose PG reads are stubbed, so the conjunction is exercised without a database. */
function sweepHarness(
  candidates: SilentHaltCandidate[],
  statuses: Record<string, { active: boolean; lastRealTurnAt: string | null }>,
  opts: { nowMs?: number; notify?: ReturnType<typeof vi.fn>; dryRun?: boolean } = {},
) {
  const nowMs = opts.nowMs ?? Date.now();
  const notify = opts.notify ?? vi.fn(async () => {});
  return {
    notify,
    run: () =>
      sweepSilentHalts({
        workspaceId: 'ws',
        dryRun: opts.dryRun,
        sql: {} as never,
        deps: {
          nowMs,
          readCandidates: async () => candidates,
          readLoopStatuses: (async () => new Map(Object.entries(statuses))) as never,
          notify,
        },
      }),
  };
}

function candidate(over: Partial<SilentHaltCandidate> = {}): SilentHaltCandidate {
  return {
    ownerId: 'su-halted',
    workspaceId: 'ws',
    routineId: 'rt_loop_su_halted',
    intervalSec: 60,
    heartbeatAgeMs: 30 * 1000,
    inactiveForMs: 120 * MIN,
    pendingAwaits: 0,
    modes: [{ mode: 'auto' }],
    ...over,
  };
}

describe('sweepSilentHalts', () => {
  const now = Date.parse('2026-09-01T07:00:00.000Z');
  const oldTurn = new Date(now - 120 * MIN).toISOString();

  it('pages the OWNER once for a halted session, with a dedupeKey', async () => {
    const h = sweepHarness([candidate()], { 'su-halted': { active: false, lastRealTurnAt: oldTurn } }, { nowMs: now });
    const r = await h.run();

    expect(r.halted).toEqual(['su-halted']);
    expect(r.paged).toEqual(['su-halted']);
    expect(h.notify).toHaveBeenCalledOnce();
    const payload = h.notify.mock.calls[0][0];
    expect(payload.importance).toBe('urgent');
    expect(payload.dedupeKey).toMatch(/^silent-halt:su-halted:/);
    expect(payload.workspaceId).toBe('ws');
  });

  it('keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages', async () => {
    // The item's central complaint: claim-discipline-watch fired hourly for four days. Two
    // sweeps 10 minutes apart over the same unchanged halt must produce the SAME key, so the
    // second is deduped by attention-notify rather than becoming a second page.
    const first = sweepHarness([candidate()], { 'su-halted': { active: false, lastRealTurnAt: oldTurn } }, { nowMs: now });
    await first.run();
    const later = now + 10 * MIN;
    const second = sweepHarness(
      [candidate({ inactiveForMs: 130 * MIN })], // same disarm instant, 10 minutes more elapsed
      { 'su-halted': { active: false, lastRealTurnAt: oldTurn } },
      { nowMs: later },
    );
    await second.run();

    expect(second.notify.mock.calls[0][0].dedupeKey).toBe(first.notify.mock.calls[0][0].dedupeKey);
  });

  it('a re-armed loop between the two round-trips is NOT paged', async () => {
    // The candidate query and the status read are separate round-trips. An agent that re-armed
    // in between is healthy, and paging it would be a false alarm sourced purely from our own
    // read skew.
    const h = sweepHarness([candidate()], { 'su-halted': { active: true, lastRealTurnAt: oldTurn } }, { nowMs: now });
    const r = await h.run();

    expect(r.halted).toEqual([]);
    expect(r.exempt['su-halted']).toMatch(/loop-armed/);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('names an exemption for every spared candidate — a mute sweep is unexplainable', async () => {
    const h = sweepHarness(
      [candidate({ ownerId: 'a', pendingAwaits: 2 }), candidate({ ownerId: 'b', heartbeatAgeMs: null })],
      { a: { active: false, lastRealTurnAt: oldTurn }, b: { active: false, lastRealTurnAt: oldTurn } },
      { nowMs: now },
    );
    const r = await h.run();

    expect(r.halted).toEqual([]);
    expect(r.exempt.a).toMatch(/pending-await/);
    expect(r.exempt.b).toMatch(/no-presence-row/);
  });

  it('dry_run detects without paging', async () => {
    const h = sweepHarness(
      [candidate()],
      { 'su-halted': { active: false, lastRealTurnAt: oldTurn } },
      { nowMs: now, dryRun: true },
    );
    const r = await h.run();

    expect(r.halted).toEqual(['su-halted']);
    expect(r.paged).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('caps pages on a mass halt — a cluster is ONE incident, not N', async () => {
    const many = Array.from({ length: SILENT_HALT_MAX_PAGES_PER_SWEEP + 3 }, (_, i) =>
      candidate({ ownerId: `su-${i}`, routineId: `rt_${i}` }),
    );
    const statuses = Object.fromEntries(many.map((c) => [c.ownerId, { active: false, lastRealTurnAt: oldTurn }]));
    const h = sweepHarness(many, statuses, { nowMs: now });
    const r = await h.run();

    expect(r.halted).toHaveLength(SILENT_HALT_MAX_PAGES_PER_SWEEP + 3);
    expect(r.paged).toHaveLength(SILENT_HALT_MAX_PAGES_PER_SWEEP);
    expect(r.pageCapReached).toBe(true);
  });

  it('a downed push transport does not throw away the remaining pages, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notify = vi.fn(async (p: { data?: Record<string, unknown> }) => {
        if (p.data?.ownerId === 'a') throw new Error('push transport down');
      });
      const h = sweepHarness(
        [candidate({ ownerId: 'a' }), candidate({ ownerId: 'b' })],
        { a: { active: false, lastRealTurnAt: oldTurn }, b: { active: false, lastRealTurnAt: oldTurn } },
        { nowMs: now, notify: notify as never },
      );
      const r = await h.run();

      expect(r.halted).toEqual(['a', 'b']);
      expect(r.paged).toEqual(['b']); // 'a' failed, 'b' still delivered
      // A swallowed failure must still be VISIBLE: a page that silently never arrived is
      // indistinguishable from no halt, which is the failure this whole module is about.
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/owner page failed for a/));
    } finally {
      warn.mockRestore();
    }
  });

  it('an empty candidate set does no status read and pages nobody', async () => {
    const notify = vi.fn(async () => {});
    const r = await sweepSilentHalts({
      workspaceId: 'ws',
      sql: {} as never,
      deps: {
        readCandidates: async () => [],
        readLoopStatuses: (() => {
          throw new Error('must not be called for an empty candidate set');
        }) as never,
        notify,
      },
    });

    expect(r.checked).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('survives a failed loop-status read by sweeping without turn evidence', async () => {
    // The disarm clock alone still establishes duration, so a status outage degrades the verdict
    // rather than silencing the detector entirely.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notify = vi.fn(async () => {});
      const r = await sweepSilentHalts({
        workspaceId: 'ws',
        sql: {} as never,
        deps: {
          nowMs: now,
          readCandidates: async () => [candidate()],
          readLoopStatuses: (async () => {
            throw new Error('pg down');
          }) as never,
          notify,
        },
      });

      expect(r.halted).toEqual(['su-halted']);
      expect(notify).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/loop-status read failed/));
    } finally {
      warn.mockRestore();
    }
  });
});
