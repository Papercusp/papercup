import { describe, expect, it } from 'vitest';
import {
  IDLE_REPAIR_QUEUE_MS,
  IDLE_RUNG_GRACE_MS,
  decideIdleQueueAction,
  runIdleQueueActuatorPass,
  type IdleQueueActuatorDeps,
  type IdleQueueEpisode,
  type IdleQueueSnapshot,
  type IdleRungResult,
} from './idle-repair-queue-actuator';

const MIN = 60_000;
const OPENED = Date.parse('2026-10-08T00:00:00Z');

function snapshot(over: Partial<IdleQueueSnapshot> = {}): IdleQueueSnapshot {
  return {
    candidate: 'ad82b273aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    repairHead: 'f07043bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    phase: 'awaiting-fixer',
    openedAtMs: OPENED,
    lastResumeRunStartedAtMs: null,
    failingLegs: 3,
    fixerSpawnId: null,
    fixerAlive: null,
    gateHolder: 'su-gate-holder',
    gateHolderWakeable: true,
    blockedReason: null,
    ...over,
  };
}

/** A stalled-queue fixture: a fake clock, a mutable queue, and a log of every effect in order. */
function fixture(
  initial: IdleQueueSnapshot,
  results: Partial<Record<'dispatch' | 'wake' | 'escalate', IdleRungResult[]>> = {},
) {
  const state = { now: OPENED, snap: initial as IdleQueueSnapshot | null, episode: null as IdleQueueEpisode | null };
  const calls: string[] = [];
  const messages: Array<{ to: string; summary: string; body: string }> = [];
  const next = (k: 'dispatch' | 'wake' | 'escalate'): IdleRungResult =>
    results[k]?.shift() ?? { ok: true, detail: `${k} ok` };
  const deps: IdleQueueActuatorDeps = {
    installSlug: 'papercusp',
    nowMs: () => state.now,
    readSnapshot: async () => state.snap,
    loadEpisode: async () => state.episode,
    saveEpisode: async (e) => {
      state.episode = e;
    },
    dispatchFixer: async () => {
      calls.push('dispatch-fixer');
      return next('dispatch');
    },
    wakeGateOwner: async (holder, msg) => {
      calls.push(`wake-gate-owner:${holder}`);
      messages.push({ to: holder, ...msg });
      return next('wake');
    },
    escalateOwner: async (msg) => {
      calls.push('escalate-owner');
      messages.push({ to: 'owner', ...msg });
      return next('escalate');
    },
  };
  const at = async (minutesAfterOpen: number) => {
    state.now = OPENED + minutesAfterOpen * MIN;
    return runIdleQueueActuatorPass(deps);
  };
  return { state, calls, messages, at };
}

describe('idle repair-queue actuator (P-002, WI-10007476)', () => {
  it('a stalled queue walks dispatch-fixer, then wake-gate-owner, then escalate-owner, in order and once each', async () => {
    const f = fixture(snapshot());
    const grace = IDLE_RUNG_GRACE_MS / MIN;
    const idle = IDLE_REPAIR_QUEUE_MS / MIN;

    expect((await f.at(idle)).decision).toBe('not-idle'); // exactly 60 min is not yet "> 60 min"
    expect(f.calls).toEqual([]);

    expect((await f.at(idle + 1)).decision).toBe('act');
    expect(f.calls).toEqual(['dispatch-fixer']);

    expect((await f.at(idle + 15)).decision).toBe('wait'); // a dispatched fixer gets the grace
    expect(f.calls).toEqual(['dispatch-fixer']);

    await f.at(idle + 1 + grace);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder']);

    await f.at(idle + 1 + 2 * grace);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder', 'escalate-owner']);

    expect((await f.at(idle + 1 + 5 * grace)).decision).toBe('exhausted');
    expect((await f.at(idle + 1 + 9 * grace)).decision).toBe('exhausted');
    expect(f.calls).toHaveLength(3); // never re-fires within one idle episode
  });

  it('the wake and the escalation both name the concrete next action, not just the age', async () => {
    const f = fixture(snapshot());
    for (const m of [61, 91, 121]) await f.at(m);
    expect(f.messages.map((m) => m.to)).toEqual(['su-gate-holder', 'owner']);
    for (const m of f.messages) {
      expect(m.summary).toContain('papercusp');
      expect(m.body).toContain("release:repair-queue { op:'admit'");
      expect(m.body).toContain('3 failing leg(s)');
    }
    // The escalation reports what the earlier rungs already did.
    expect(f.messages[1].body).toMatch(/dispatch-fixer: acted .*wake-gate-owner: acted/);
  });

  it('a failed dispatch falls through to the gate owner in the SAME pass', async () => {
    const f = fixture(snapshot(), { dispatch: [{ ok: false, detail: 'dispatcher refused: reservation held' }] });
    const r = await f.at(61);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder']);
    expect(r.acted.map((a) => a.outcome)).toEqual(['failed', 'acted']);
    expect(f.state.episode?.rungs['dispatch-fixer']?.detail).toBe('dispatcher refused: reservation held');
  });

  it('with no wakeable gate holder a failed dispatch goes straight to the owner', async () => {
    const f = fixture(snapshot({ gateHolderWakeable: false }), { dispatch: [{ ok: false, detail: 'spawn plane down' }] });
    await f.at(61);
    expect(f.calls).toEqual(['dispatch-fixer', 'escalate-owner']);
    expect(f.state.episode?.rungs['wake-gate-owner']?.outcome).toBe('not-applicable');

    const unheld = fixture(snapshot({ gateHolder: null }), { dispatch: [{ ok: false, detail: 'x' }] });
    await unheld.at(61);
    expect(unheld.calls).toEqual(['dispatch-fixer', 'escalate-owner']);
  });

  it('a live fixer is not doubled: no dispatch, the grace, then the gate owner', async () => {
    const f = fixture(snapshot({ fixerSpawnId: 'spawn-live', fixerAlive: true }));
    expect((await f.at(61)).decision).toBe('wait');
    expect(f.calls).toEqual([]);
    expect(f.state.episode?.rungs['dispatch-fixer']?.detail).toContain('spawn-live');
    await f.at(61 + IDLE_RUNG_GRACE_MS / MIN);
    expect(f.calls).toEqual(['wake-gate-owner:su-gate-holder']);
  });

  it('a queue waiting on a gate run skips the fixer and names release:checkpoint-run', async () => {
    const f = fixture(snapshot({ phase: 'ready-to-verify' }));
    await f.at(61);
    expect(f.calls).toEqual(['wake-gate-owner:su-gate-holder']);
    expect(f.messages[0].body).toContain('release:checkpoint-run');
    expect(f.messages[0].body).toContain('f07043bbbbbb');
    expect(f.state.episode?.rungs['dispatch-fixer']?.outcome).toBe('not-applicable');
  });

  it('a round starting ends the episode; the next stall climbs the ladder again from rung 1', async () => {
    const f = fixture(snapshot());
    await f.at(61);
    await f.at(91);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder']);

    // A round starts at +100 min: not idle again until +160, and the stored episode is cleared.
    f.state.snap = snapshot({ lastResumeRunStartedAtMs: OPENED + 100 * MIN });
    expect((await f.at(130)).decision).toBe('not-idle');
    expect(f.state.episode).toBeNull();

    await f.at(161);
    expect(f.calls).toEqual(['dispatch-fixer', 'wake-gate-owner:su-gate-holder', 'dispatch-fixer']);
  });

  it('nothing fires without failing legs, on a promotable queue, or with no queue at all', async () => {
    for (const snap of [snapshot({ failingLegs: 0 }), snapshot({ phase: 'ready-to-promote' }), null]) {
      const f = fixture(snapshot());
      f.state.snap = snap;
      expect((await f.at(600)).decision).toBe('not-idle');
      expect(f.calls).toEqual([]);
    }
  });

  it('a failed owner escalation is retried after the grace, never left silently exhausted', async () => {
    const f = fixture(snapshot({ phase: 'blocked', gateHolder: null, blockedReason: 'attempts-exhausted' }), {
      escalate: [{ ok: false, detail: 'attention surface down' }],
    });
    await f.at(61);
    expect(f.calls).toEqual(['escalate-owner']);
    expect((await f.at(80)).decision).toBe('wait');
    await f.at(61 + IDLE_RUNG_GRACE_MS / MIN);
    expect(f.calls).toEqual(['escalate-owner', 'escalate-owner']);
    expect(f.messages[1].body).toContain('attempts-exhausted');
    expect((await f.at(300)).decision).toBe('exhausted');
  });

  it('decideIdleQueueAction is pure: it never mutates the prior episode it was handed', () => {
    const prior: IdleQueueEpisode = { candidate: snapshot().candidate, idleSinceMs: OPENED, rungs: {} };
    const frozen = JSON.stringify(prior);
    decideIdleQueueAction(snapshot({ phase: 'ready-to-test' }), prior, OPENED + 61 * MIN);
    expect(JSON.stringify(prior)).toBe(frozen);
  });
});
