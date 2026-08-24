/**
 * liveness-parity.test.ts — the cross-surface liveness parity contract
 * (presence-derivation-unification-2026-07-17 P-001).
 *
 * THE EXECUTABLE SPEC: an agent in a given canonical state must get the SAME
 * sessionState verdict from every read surface. Before the oracle landed, each
 * surface hand-assembled a different subset of deriveSessionState's inputs —
 * coord:roster's claims lens vs its live lens disagreed inside ONE tool, and
 * the send-miss path called a reboot-killed session `parked` (audit F1/F2).
 *
 * Surfaces exercised here at their PURE seams (all of which now route through
 * liveness-oracle.deriveVerdict — coord:presence's assemblePresenceSnapshot
 * calls it inline and is covered structurally + by its own suite):
 *   - deriveVerdict            (the oracle — coord:presence / snapshot path)
 *   - resolveSessionStates     (the batched oracle — send/handoff MISS path)
 *   - foldFleetRoster          (fleet:status)
 *   - foldHiveRoster           (hive roster → Queen survey / spawn dossier)
 *   - reconcileWakeability     (fleet:assignments + coord:roster view=claims)
 *   - applyPsuHostAuthority    (fleet:leader-brief's psu-host leg, P-005)
 *
 * The six canonical states (plan P-001):
 *   1. turn-in-flight          → live
 *   2. parked (wakeable, idle) → parked
 *   3. zombie-await dead       → ended   (reboot/SIGKILL left the await armed;
 *                                         heartbeat past PRESENCE_DEAD_MS)
 *   4. pid-dead local          → ended   (kill(pid,0) ESRCH — oracle level)
 *   5. recorded, unregistered  → recorded (adv_sessions live, no await yet)
 *   6. cleanly ended           → ended
 */
import { describe, expect, it } from 'vitest';
import {
  classifyReadActionability,
  deriveVerdict,
  resolveSessionStates,
  applyPsuHostAuthority,
  type LivenessSubject,
} from './liveness-oracle';
import type { WakeabilitySignals, SessionState } from './presence-wakeability';
import { PRESENCE_DEAD_MS } from './presence-wakeability';
import { foldFleetRoster, type FleetFoldPresence } from '../../fleet/fleet-roster';
import { foldHiveRoster, type FoldPresence } from '../../fleet/hive-roster';
import { reconcileWakeability } from '../fleet/assignments';
import type { AgentAssignment } from '../../fleet/assignments';

// Anchored to the REAL clock: reconcileWakeability / resolveSessionStates use
// Date.now() internally (no nowMs seam), so fixture heartbeats must be relative
// to it. The thresholds under test are minutes-scale; test runtime is seconds.
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

interface CanonicalState {
  name: string;
  ownerId: string;
  wake: WakeabilitySignals;
  heartbeatAt: string;
  stale: boolean;
  recordedLive: boolean;
  /** null = probe inconclusive (the fold-path default on foreign hosts). */
  pidProbe: boolean | null;
  expected: SessionState;
}

const STATES: CanonicalState[] = [
  {
    name: 'turn-in-flight',
    ownerId: 'su-turn',
    wake: { wakeable: true, liveTurn: true },
    heartbeatAt: iso(5_000),
    stale: false,
    recordedLive: false,
    pidProbe: null,
    expected: 'live',
  },
  {
    name: 'parked (wakeable, idle)',
    ownerId: 'su-parked',
    wake: { wakeable: true, liveTurn: false },
    heartbeatAt: iso(30_000),
    stale: false,
    recordedLive: false,
    pidProbe: null,
    expected: 'parked',
  },
  {
    name: 'zombie-await dead (reboot left the await armed)',
    ownerId: 'su-zombie',
    wake: { wakeable: true, liveTurn: false },
    heartbeatAt: iso(PRESENCE_DEAD_MS + 60_000),
    stale: true,
    recordedLive: false,
    pidProbe: null,
    expected: 'ended',
  },
  {
    name: 'pid confirmed dead (local ESRCH)',
    ownerId: 'su-piddead',
    wake: { wakeable: true, liveTurn: false },
    heartbeatAt: iso(30_000),
    stale: false,
    recordedLive: false,
    pidProbe: false,
    expected: 'ended',
  },
  {
    name: 'recorded (session-log live, not yet coord-registered)',
    ownerId: 'su-recorded',
    wake: { wakeable: false, liveTurn: false },
    heartbeatAt: iso(30_000),
    stale: false,
    recordedLive: true,
    pidProbe: null,
    expected: 'recorded',
  },
  {
    name: 'cleanly ended',
    ownerId: 'su-ended',
    wake: { wakeable: false, liveTurn: false },
    heartbeatAt: iso(120_000),
    stale: false,
    recordedLive: false,
    pidProbe: null,
    expected: 'ended',
  },
];

const wakeMap = new Map(STATES.map((s) => [s.ownerId, s.wake]));
const recordedSet = new Set(STATES.filter((s) => s.recordedLive).map((s) => s.ownerId));
const pidOf = (s: CanonicalState) => 10_000 + STATES.indexOf(s);
/** Injected pid probe, keyed by the fixture owner's unique pid. */
const probeFor =
  (states: CanonicalState[]) =>
  (r: { host?: string | null; pid?: number | null }): boolean | null => {
    const st = states.find((x) => r.pid === pidOf(x));
    return st ? st.pidProbe : null;
  };

function subjectOf(s: CanonicalState): LivenessSubject {
  return {
    ownerId: s.ownerId,
    heartbeatAt: s.heartbeatAt,
    stale: s.stale,
    pid: pidOf(s),
    host: 'fixture-host',
  };
}

describe('cross-surface liveness parity (P-001)', () => {
  it('classifies read-time owner gates conservatively', () => {
    expect(classifyReadActionability('live')).toBe('actionable');
    expect(classifyReadActionability('parked')).toBe('actionable');
    expect(classifyReadActionability('recorded')).toBe('actionable');

    expect(classifyReadActionability('draining')).toBe('non-actionable');
    expect(classifyReadActionability('suspect')).toBe('non-actionable');
    expect(classifyReadActionability('ended')).toBe('non-actionable');

    // A missing oracle row means the liveness read degraded; it must never
    // silently become an owner-facing Decision.
    expect(classifyReadActionability(null)).toBe('unknown');
    expect(classifyReadActionability(undefined)).toBe('unknown');
  });

  it('deriveVerdict (the oracle / coord:presence path) matches the canonical table', () => {
    for (const s of STATES) {
      const v = deriveVerdict(subjectOf(s), s.wake, recordedSet, NOW, probeFor(STATES));
      expect(v.sessionState, s.name).toBe(s.expected);
      expect(v.wakeable, s.name).toBe(s.wake.wakeable);
      expect(v.heartbeatFresh, s.name).toBe(!s.stale);
    }
  });

  it('an actively tool-calling recorded successor is live before its inbox wake is armed', () => {
    const v = deriveVerdict(
      {
        ownerId: 'su-recorded-active',
        source: 'session-log',
        heartbeatAt: iso(5_000),
        stale: false,
      },
      { wakeable: false, liveTurn: true },
      new Set(['su-recorded-active']),
      NOW,
      () => null,
    );

    expect(v.sessionState).toBe('live');
    expect(v.wakeable).toBe(false);
    expect(v.confirmLiveness).toBe(false);
  });

  it('resolveSessionStates (the send/handoff MISS path) agrees, including via hydration', async () => {
    const verdicts = await resolveSessionStates(
      // Bare ids only — hydration must fill heartbeat/stale/pid, exactly like
      // describeMissedRecipients' call shape.
      STATES.map((s) => ({ ownerId: s.ownerId })),
      {
        hydratePerId: true,
        fetchWakeabilityFn: async () => wakeMap,
        fetchRecordedLiveFn: async () => recordedSet,
        probePidFn: probeFor(STATES),
        getPresenceFn: async (ownerId) => {
          const s = STATES.find((st) => st.ownerId === ownerId);
          if (!s) return null;
          return {
            heartbeatAt: s.heartbeatAt,
            stale: s.stale,
            host: 'fixture-host',
            pid: pidOf(s),
            source: 'psu',
          };
        },
      },
    );
    for (const s of STATES) {
      expect(verdicts.get(s.ownerId)?.sessionState, s.name).toBe(s.expected);
    }
  });

  it('foldFleetRoster (fleet:status) agrees and gates `alive` on the verdict', () => {
    // The fold calls deriveVerdict with the REAL pid probe; fixture host never
    // matches this machine → probe inconclusive (null). The pid-dead case is
    // oracle-level (above), so assert the other five here.
    const foldStates = STATES.filter((s) => s.pidProbe === null);
    const presence: FleetFoldPresence[] = foldStates.map((s) => ({
      ownerId: s.ownerId,
      ownerLabel: s.ownerId,
      source: 'psu',
      intent: '',
      currentPlanSlug: null,
      host: 'fixture-host',
      startedAt: null,
      heartbeatAt: s.heartbeatAt,
      lastActiveAt: null,
      agentRole: 'su',
      fleetSlug: 'f',
      fleetRole: 'member',
      userId: null,
      stale: s.stale,
      pid: pidOf(s),
    }));
    const entries = foldFleetRoster(presence, [], new Map(), NOW, wakeMap, recordedSet);
    for (const s of foldStates) {
      const e = entries.find((x) => x.agentId === s.ownerId);
      expect(e?.sessionState, s.name).toBe(s.expected);
      const expectAlive = !['ended', 'suspect', 'draining'].includes(s.expected);
      expect(e?.alive, `${s.name} alive-gating`).toBe(expectAlive);
    }
  });

  it('foldHiveRoster (Queen survey / spawn dossier) agrees and gates `alive`', () => {
    const foldStates = STATES.filter((s) => s.pidProbe === null);
    const presence: FoldPresence[] = foldStates.map((s) => ({
      ownerId: s.ownerId,
      ownerLabel: s.ownerId,
      source: 'psu',
      intent: '',
      currentPlanSlug: null,
      host: 'fixture-host',
      startedAt: null,
      heartbeatAt: s.heartbeatAt,
      lastActiveAt: null,
      agentRole: 'su',
      potSlug: 'pot',
      userId: null,
      stale: s.stale,
      pid: pidOf(s),
    }));
    const entries = foldHiveRoster(presence, [], new Map(), NOW, wakeMap, recordedSet);
    for (const s of foldStates) {
      const e = entries.find((x) => x.agentId === s.ownerId);
      expect(e?.sessionState, s.name).toBe(s.expected);
      const expectAlive = !['ended', 'suspect', 'draining'].includes(s.expected);
      expect(e?.alive, `${s.name} alive-gating`).toBe(expectAlive);
    }
  });

  it('reconcileWakeability (fleet:assignments + coord:roster view=claims) agrees', async () => {
    const foldStates = STATES.filter((s) => s.pidProbe === null);
    const agents = foldStates.map(
      (s) =>
        ({
          agentId: s.ownerId,
          label: s.ownerId,
          name: null,
          present: true,
          alive: !s.stale,
          heartbeatAt: s.heartbeatAt,
          intent: '',
          declaredPlanSlug: null,
          claims: [],
          orphaned: false,
          stalled: false,
          declaredUnclaimed: false,
          doing: null,
          queued: [],
          load: 0,
        }) as AgentAssignment & { sessionState?: SessionState | null },
    );
    await reconcileWakeability(
      agents,
      async () => wakeMap,
      async () => recordedSet,
    );
    for (const s of foldStates) {
      const a = agents.find((x) => x.agentId === s.ownerId);
      expect(a?.sessionState, s.name).toBe(s.expected);
      const expectAlive = !['ended', 'suspect', 'draining'].includes(s.expected);
      expect(a?.alive, `${s.name} alive-gating`).toBe(expectAlive);
    }
  });

  it('claims-held dead owners are `suspect` (not `ended`) on every surface', async () => {
    const zombie = STATES.find((s) => s.ownerId === 'su-zombie')!;
    const v = deriveVerdict(
      { ...subjectOf(zombie), claimsHeld: true },
      zombie.wake,
      recordedSet,
      NOW,
      probeFor(STATES),
    );
    expect(v.sessionState).toBe('suspect');
    expect(v.confirmLiveness).toBe(true);
  });

  it('applyPsuHostAuthority (leader-brief P-005 leg): live/parked + no live host ⇒ ended, cups exempt', () => {
    const agents = [
      { agentId: 'su-parked-nohost', sessionState: 'parked' as SessionState, alive: true },
      { agentId: 'cup-parked-nohost', sessionState: 'parked' as SessionState, alive: true },
      { agentId: 'su-live-nohost', sessionState: 'live' as SessionState, alive: true },
    ];
    const roles = new Map<string, string | null>([
      ['su-parked-nohost', 'su'],
      ['cup-parked-nohost', 'cup'],
      ['su-live-nohost', 'su'],
    ]);
    applyPsuHostAuthority(agents, roles, () => null);
    expect(agents[0].sessionState).toBe('ended');
    expect(agents[0].alive).toBe(false);
    expect(agents[1].sessionState).toBe('parked'); // nursery-governed, never host-probed
    expect(agents[2].sessionState).toBe('ended'); // recent activity cannot outvote a missing host
    expect(agents[2].alive).toBe(false);
  });

  it('positive psu-host evidence rescues an ended non-wakeable su session', () => {
    const v = deriveVerdict(
      {
        ownerId: 'su-pty-live',
        agentRole: 'su',
        heartbeatAt: iso(PRESENCE_DEAD_MS + 60_000),
        stale: true,
      },
      { wakeable: false, liveTurn: false },
      new Set(),
      NOW,
      () => null,
      { enabled: true, negative: false, positive: true, findHostFn: () => ({ ownerId: 'su-pty-live' }) },
    );

    expect(v.sessionState).toBe('recorded');
    expect(v.wakeable).toBe(false);
  });
});
