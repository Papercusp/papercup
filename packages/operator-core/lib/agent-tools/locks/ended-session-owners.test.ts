/**
 * ended-session-owners.test.ts — the SESSION half of the dead-holder reclaim
 * predicate (EI-22078335832051825), PG-free via the DI seams.
 *
 * What this pins, and why each rail is load-bearing:
 *  - PRESENCE GATE: an owner with no coord_presence row is never a subject,
 *    even when the oracle would call it `ended`. The oracle's pure model reads
 *    "no wake, no turn" as `ended`, which is a FALSE death for a peer host's
 *    `system:git-sync:<pid>:…` lease — reclaiming that lets two live holders
 *    race the resource. A deliberately-wrong ungated implementation is kept
 *    beside the real one as a permanent control, so the gate is provably
 *    falsifiable without mutating the shared tree.
 *  - `ended` ONLY: suspect / draining / parked / live / recorded / null and
 *    signalMissing all keep the holder.
 *  - FAIL-SAFE: a store or oracle failure returns the empty set, never a
 *    partial verdict.
 *
 * In-tree (operator-core, tab-visible).
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/locks/ended-session-owners.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

import {
  endedSessionOwners,
  isDefinitivelyEndedVerdict,
  type EndedSessionOwnersDeps,
} from './ended-session-owners';
import type { LivenessSubject, LivenessVerdict } from '../coordination/liveness-oracle';
import type { PresenceRecord } from '../coordination/presence';

const ENDED_SESSION = 'su-0542551f-dead-session';
const LIVE_SESSION = 'su-4d1115a1-live-session';
const PEER_FIRE = 'system:git-sync:4242:peer-host-fire';
const TERMINAL_TASK_OWNER = 's-invoke-88ee4ec4-32f4-4988-90aa-fb9b38cc49f4';

function presenceRow(ownerId: string, over: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    ownerId,
    ownerLabel: `su · ${ownerId.slice(0, 8)}`,
    workspaceId: 'papercusp-workspace',
    source: 'omp-hook-session',
    intent: '',
    currentPlanSlug: null,
    currentFiles: [],
    host: 'this-box',
    pid: process.pid, // ALIVE — the warm-dead shape the pid test cannot see
    tty: null,
    startedAt: '2026-09-01T16:00:00.000Z',
    heartbeatAt: '2026-09-01T17:00:00.000Z',
    lastActiveAt: null,
    intentDeclaredAt: null,
    agentRole: 'su',
    potSlug: 'papercusp',
    capabilityTags: [],
    ...over,
  } as PresenceRecord;
}

function verdict(ownerId: string, over: Partial<LivenessVerdict> = {}): LivenessVerdict {
  return {
    ownerId,
    sessionState: 'parked',
    wakeable: true,
    liveTurn: false,
    confirmLiveness: null,
    heartbeatFresh: true,
    ...over,
  };
}

/** A presence store that knows only the SESSION owners, never the peer fire. */
function sessionsOnlyPresence(...known: string[]) {
  return vi.fn(async (ownerId: string) => (known.includes(ownerId) ? presenceRow(ownerId) : null));
}

/** An oracle that calls EVERY subject it is given `ended` — the pure model's
 *  reading for an owner with no wake and no turn, session or not. */
function endsEverything() {
  return vi.fn(async (subjects: readonly LivenessSubject[]) =>
    new Map(subjects.map((s) => [s.ownerId, verdict(s.ownerId, { sessionState: 'ended', wakeable: false })])),
  );
}

function noAgentTasks() {
  return vi.fn(async () => []);
}

/**
 * THE CONTROL: the pre-fix reading with the presence gate removed — every owner
 * is a subject. Kept permanently so a regression that drops the gate cannot pass
 * by accident: on the peer-fire input the two implementations must disagree.
 */
async function ungatedControl(
  owners: readonly string[],
  deps: Required<Pick<EndedSessionOwnersDeps, 'getPresenceFn' | 'resolveSessionStatesFn'>>,
): Promise<ReadonlySet<string>> {
  const verdicts = await deps.resolveSessionStatesFn(owners.map((ownerId) => ({ ownerId })));
  return new Set(owners.filter((o) => isDefinitivelyEndedVerdict(verdicts.get(o))));
}

describe('endedSessionOwners — the presence gate (rail 1)', () => {
  it('condemns a session the oracle calls ended, even though its pid is alive', async () => {
    const getPresenceFn = sessionsOnlyPresence(ENDED_SESSION);
    const resolveSessionStatesFn = endsEverything();
    const dead = await endedSessionOwners([ENDED_SESSION], { getPresenceFn, resolveSessionStatesFn });
    expect([...dead]).toEqual([ENDED_SESSION]);
    // The subject carried the presence row's own legs, not a bare id.
    expect(resolveSessionStatesFn).toHaveBeenCalledWith([
      expect.objectContaining({ ownerId: ENDED_SESSION, pid: process.pid, host: 'this-box', agentRole: 'su' }),
    ]);
  });

  it('never puts an owner with NO presence row to the oracle (a peer fire is unknown, not dead)', async () => {
    const getPresenceFn = sessionsOnlyPresence(ENDED_SESSION);
    const resolveSessionStatesFn = endsEverything();
    const dead = await endedSessionOwners([PEER_FIRE], {
      getPresenceFn,
      resolveSessionStatesFn,
      readAgentTasksFn: noAgentTasks(),
    });
    expect(dead.size).toBe(0);
    // Not merely "not condemned" — never even ASKED, so the oracle's false
    // reading for a non-session owner cannot leak in through any future leg.
    expect(resolveSessionStatesFn).not.toHaveBeenCalled();
  });

  it('condemns a presence-absent owner whose latest correlated agent-session task is terminal and none is live', async () => {
    const readAgentTasksFn = vi.fn(async (_ownerId: string, states?: readonly string[]) =>
      states ? [] : [{ state: 'timed_out' as const }],
    );
    const resolveSessionStatesFn = endsEverything();
    const dead = await endedSessionOwners([TERMINAL_TASK_OWNER], {
      getPresenceFn: sessionsOnlyPresence(),
      resolveSessionStatesFn,
      readAgentTasksFn,
    });
    expect([...dead]).toEqual([TERMINAL_TASK_OWNER]);
    expect(resolveSessionStatesFn).not.toHaveBeenCalled();
    expect(readAgentTasksFn).toHaveBeenNthCalledWith(1, TERMINAL_TASK_OWNER);
    expect(readAgentTasksFn).toHaveBeenNthCalledWith(2, TERMINAL_TASK_OWNER, ['pending', 'running']);
  });

  it('keeps a task-backed owner when any correlated agent-session task is still live', async () => {
    const readAgentTasksFn = vi.fn(async (_ownerId: string, states?: readonly string[]) =>
      states ? [{ state: 'running' as const }] : [{ state: 'timed_out' as const }],
    );
    const dead = await endedSessionOwners([TERMINAL_TASK_OWNER], {
      getPresenceFn: sessionsOnlyPresence(),
      resolveSessionStatesFn: endsEverything(),
      readAgentTasksFn,
    });
    expect(dead.size).toBe(0);
  });

  it('keeps a presence-absent owner whose latest agent-session task is non-terminal', async () => {
    const readAgentTasksFn = vi.fn(async () => [{ state: 'unaccounted' as const }]);
    const dead = await endedSessionOwners([TERMINAL_TASK_OWNER], {
      getPresenceFn: sessionsOnlyPresence(),
      resolveSessionStatesFn: endsEverything(),
      readAgentTasksFn,
    });
    expect(dead.size).toBe(0);
    expect(readAgentTasksFn).toHaveBeenCalledTimes(1);
  });

  it('keeps an opaque owner with neither presence nor a correlated agent-session task', async () => {
    const readAgentTasksFn = vi.fn(async () => []);
    const dead = await endedSessionOwners([PEER_FIRE], {
      getPresenceFn: sessionsOnlyPresence(),
      resolveSessionStatesFn: endsEverything(),
      readAgentTasksFn,
    });
    expect(dead.size).toBe(0);
    expect(readAgentTasksFn).toHaveBeenCalledWith(PEER_FIRE);
  });

  it('is falsifiable: the ungated control condemns the peer fire on the same inputs', async () => {
    const deps = {
      getPresenceFn: sessionsOnlyPresence(ENDED_SESSION),
      resolveSessionStatesFn: endsEverything(),
      readAgentTasksFn: noAgentTasks(),
    };
    const control = await ungatedControl([PEER_FIRE], deps);
    expect([...control]).toEqual([PEER_FIRE]); // the control is WRONG here, by design
    const real = await endedSessionOwners([PEER_FIRE], deps);
    expect(real.size).toBe(0);
    // Calibration: on a genuine ended session the two agree, so the control is
    // not simply weaker everywhere — it differs exactly where the gate matters.
    expect([...(await ungatedControl([ENDED_SESSION], deps))]).toEqual([ENDED_SESSION]);
    expect([...(await endedSessionOwners([ENDED_SESSION], deps))]).toEqual([ENDED_SESSION]);
  });

  it('mixes: only the known-and-ended owner of a mixed holder set is condemned, in one oracle call', async () => {
    const getPresenceFn = sessionsOnlyPresence(ENDED_SESSION, LIVE_SESSION);
    const resolveSessionStatesFn = vi.fn(async (subjects: readonly LivenessSubject[]) =>
      new Map(
        subjects.map((s) => [
          s.ownerId,
          verdict(s.ownerId, s.ownerId === ENDED_SESSION ? { sessionState: 'ended', wakeable: false } : { sessionState: 'live', liveTurn: true }),
        ]),
      ),
    );
    const dead = await endedSessionOwners([PEER_FIRE, LIVE_SESSION, ENDED_SESSION, ENDED_SESSION], {
      getPresenceFn,
      resolveSessionStatesFn,
      readAgentTasksFn: noAgentTasks(),
    });
    expect([...dead]).toEqual([ENDED_SESSION]);
    expect(resolveSessionStatesFn).toHaveBeenCalledTimes(1);
    const asked = resolveSessionStatesFn.mock.calls[0][0].map((s) => s.ownerId);
    expect(asked).toEqual([LIVE_SESSION, ENDED_SESSION]); // deduped, peer fire absent
  });

  it('returns the empty set for an empty input without touching either store', async () => {
    const getPresenceFn = sessionsOnlyPresence(ENDED_SESSION);
    const resolveSessionStatesFn = endsEverything();
    expect((await endedSessionOwners([], { getPresenceFn, resolveSessionStatesFn })).size).toBe(0);
    expect((await endedSessionOwners(['', ''], { getPresenceFn, resolveSessionStatesFn })).size).toBe(0);
    expect(getPresenceFn).not.toHaveBeenCalled();
    expect(resolveSessionStatesFn).not.toHaveBeenCalled();
  });
});

describe('endedSessionOwners — `ended` only (rail 2)', () => {
  const keeps: Array<[string, Partial<LivenessVerdict>]> = [
    ['live', { sessionState: 'live', liveTurn: true }],
    ['parked', { sessionState: 'parked' }],
    ['draining', { sessionState: 'draining' }],
    ['recorded', { sessionState: 'recorded', wakeable: false }],
    // Dead-but-holding-claims: the oracle itself hedges, so we do not act.
    ['suspect', { sessionState: 'suspect', wakeable: false }],
    // The in-band unknown: absence of evidence is not evidence of absence.
    ['null + signalMissing', { sessionState: null, signalMissing: true, wakeable: false, confirmLiveness: true }],
  ];
  for (const [label, over] of keeps) {
    it(`keeps a holder whose verdict is ${label}`, async () => {
      const dead = await endedSessionOwners([LIVE_SESSION], {
        getPresenceFn: sessionsOnlyPresence(LIVE_SESSION),
        resolveSessionStatesFn: async (subjects) => new Map(subjects.map((s) => [s.ownerId, verdict(s.ownerId, over)])),
      });
      expect(dead.size).toBe(0);
    });
  }

  it('keeps a holder the oracle omitted from its result (a missing key is "not asked", never a verdict)', async () => {
    const dead = await endedSessionOwners([LIVE_SESSION], {
      getPresenceFn: sessionsOnlyPresence(LIVE_SESSION),
      resolveSessionStatesFn: async () => new Map(),
    });
    expect(dead.size).toBe(0);
  });

  it('isDefinitivelyEndedVerdict is the one line that widens: ended ⇒ true, everything else ⇒ false', () => {
    expect(isDefinitivelyEndedVerdict(verdict('x', { sessionState: 'ended' }))).toBe(true);
    expect(isDefinitivelyEndedVerdict(verdict('x', { sessionState: 'ended', signalMissing: true }))).toBe(false);
    expect(isDefinitivelyEndedVerdict(verdict('x', { sessionState: 'suspect' }))).toBe(false);
    expect(isDefinitivelyEndedVerdict(verdict('x', { sessionState: null }))).toBe(false);
    expect(isDefinitivelyEndedVerdict(undefined)).toBe(false);
  });
});

describe('endedSessionOwners — fail-safe (nothing reclaimed on any failure)', () => {
  it('a presence-store failure on one owner leaves THAT owner unknown and still judges the rest', async () => {
    const getPresenceFn = vi.fn(async (ownerId: string) => {
      if (ownerId === LIVE_SESSION) throw new Error('presence store hiccup');
      return presenceRow(ownerId);
    });
    const dead = await endedSessionOwners([LIVE_SESSION, ENDED_SESSION], {
      getPresenceFn,
      resolveSessionStatesFn: endsEverything(),
      readAgentTasksFn: vi.fn(async () => [{ state: 'timed_out' as const }]),
    });
    expect([...dead]).toEqual([ENDED_SESSION]);
  });

  it('an oracle failure condemns nobody', async () => {
    const dead = await endedSessionOwners([ENDED_SESSION], {
      getPresenceFn: sessionsOnlyPresence(ENDED_SESSION),
      resolveSessionStatesFn: async () => {
        throw new Error('oracle unavailable');
      },
    });
    expect(dead.size).toBe(0);
  });

  it('a task-ledger read failure condemns nobody, including a presence-backed ended session', async () => {
    const dead = await endedSessionOwners([ENDED_SESSION, TERMINAL_TASK_OWNER], {
      getPresenceFn: sessionsOnlyPresence(ENDED_SESSION),
      resolveSessionStatesFn: endsEverything(),
      readAgentTasksFn: async () => {
        throw new Error('task ledger unavailable');
      },
    });
    expect(dead.size).toBe(0);
  });
});
