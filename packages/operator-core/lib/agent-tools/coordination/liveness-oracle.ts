/**
 * liveness-oracle.ts — THE single agent-liveness verdict assembly
 * (presence-derivation-unification-2026-07-17 P-002 / P-005).
 *
 * `deriveSessionState` (presence-wakeability.ts) has always been the one PURE
 * verdict model — but its INPUT ASSEMBLY was re-composed by hand at every call
 * site, and each site picked a different subset of the legs:
 *
 *   - coord:presence (presence-snapshot.ts) fed all legs (wakeability + liveTurn
 *     + hardStale + pid probe + recorded + claimsHeld);
 *   - fleet:status (fleet-roster.ts) skipped the pid probe + the recorded leg;
 *   - fleet:assignments (reconcileWakeability) skipped the pid probe;
 *   - coord:send's MISS path (recipient-liveness.ts) skipped hardStale AND the
 *     pid probe — so a zombie-await dead session read `parked` exactly where the
 *     caller was deciding whether a transfer black-holed;
 *   - fleet:leader-brief applied a psu-host authority NO other surface applied.
 *
 * The same agent could therefore get a DIFFERENT verdict per tool. This module
 * is the fix: ONE `resolveSessionStates` that batches every input leg the same
 * way for every caller. Surfaces differ only in how they PROJECT the verdict,
 * never in how they derive it (D-001: one derivation, many lenses).
 *
 * The legs, all optional-but-uniform:
 *   1. wakeability + liveTurn — fetchWakeability (event_awaits + agent_activity).
 *   2. recorded — adv_sessions session-log authority: a NOT-wakeable owner whose
 *      recorded session is live (ended_at IS NULL) is `recorded` (alive, not
 *      inbox-wake-dispatchable), never `ended`. Unifies the two prior spellings
 *      (snapshot's source === RECORDED_SESSION_SOURCE; assignments'
 *      recordedLiveOwnerIds set) by accepting EITHER signal.
 *   3. hardStale — the PRESENCE_DEAD_MS (30m) zombie-await ceiling, from the
 *      subject's heartbeat.
 *   4. pid probe — probeProcessLiveness for rows carrying a supervisor-beat
 *      pid/host (WI-3898 P1); ESRCH is authoritative-dead in seconds.
 *   5. claimsHeld — caller-known claims classify a confirmed-dead owner as
 *      `suspect` until claim cleanup reconciles.
 *   6. psu-host authority (P-005, OPT-IN) — the box-local psu-pty host registry:
 *      a non-cup subject whose verdict lands `parked` but has NO live psu host is
 *      `ended` (a dead host can strand a fresh heartbeat + wake-await). Opt-in
 *      (`psuHostAuthority: true`) because findLiveHost cannot distinguish "never
 *      pty-hosted here" from "host dead" — enable it only for cohorts known to be
 *      psu-pty-hosted (leader-brief's desktop fleet members).
 *
 * Callers with only ownerIds (the send/handoff MISS path) can set
 * `hydratePerId: true` to fill heartbeat/stale/host/pid/source from each
 * subject's own coord_presence row, so a bare-id verdict carries the same legs
 * as a roster verdict.
 *
 * Every fetch is batched per CALL (never per subject) and injectable for
 * PG-free unit tests. The cross-surface parity contract is enforced by
 * liveness-parity.test.ts (P-001).
 */

import { probeProcessLiveness, getPresence } from './presence';
import {
  fetchWakeability,
  deriveSessionState,
  isHardStale,
  needsLivenessConfirmation,
  type SessionState,
  type WakeabilitySignals,
} from './presence-wakeability';
// Constant-only import from the pure package — see presence-wakeability.ts (WI-39450).
// The `probeProcessLiveness`/`getPresence` import above legitimately needs the local
// module; this constant does not, and routing it through the blanket-mocked './presence'
// is what stranded it in unit-test collection.
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import {
  fetchSelfWake,
  type SelfWakeSignals,
  type SelfWakeSource,
} from './presence-selfwake';
import { RECORDED_SESSION_SOURCE } from './recorded-sessions';
import { recordedLiveOwnerIds } from '../../adv-sessions';
import { findLiveHost } from '../../events/await/psu-pty-discovery';

/** The per-owner inputs a caller supplies. Everything beyond `ownerId` is
 *  optional — a missing leg degrades exactly like the legacy call sites did
 *  (never a throw), and `hydratePerId` can fill the presence-row-derived
 *  fields from the store. */
export interface LivenessSubject {
  ownerId: string;
  /** ISO heartbeat timestamp (drives stale + the hardStale dead-ceiling). */
  heartbeatAt?: string | null;
  /** Precomputed heartbeat-freshness flag (PgPresenceStore's `stale`). When
   *  absent it is derived from `heartbeatAt` (> PRESENCE_STALE_MS ⇒ stale);
   *  when neither is present it defaults to false (legacy miss-path parity). */
  stale?: boolean | null;
  /** Caller-known claims signal (plan-item lane / work-item load) — classifies
   *  a confirmed-dead owner as `suspect` until claim cleanup runs. */
  claimsHeld?: boolean;
  /** Supervisor-beat pid/host when the row carries them (WI-3898 P1) — enables
   *  the local kill(pid,0) probe. */
  host?: string | null;
  pid?: number | null;
  /** Presence-row source — RECORDED_SESSION_SOURCE rows short-circuit to
   *  `recorded` when not wakeable (session-log-authoritative; never
   *  force-ended by heartbeat). */
  source?: string | null;
  /** Cohort hint for the psu-host authority leg (P-005): only non-'cup' rows
   *  with a KNOWN role may consult findLiveHost; bees stay nursery-governed. */
  agentRole?: string | null;
}

/** The unified verdict every surface projects from. */
export interface LivenessVerdict {
  ownerId: string;
  sessionState: SessionState;
  wakeable: boolean;
  liveTurn: boolean;
  /** WI-4400: draining/suspect verdicts need a fresh required wake before a
   *  coordinator assumes the owner is dead or alive. */
  confirmLiveness: boolean | null;
  /** RAW heartbeat freshness (heartbeat within PRESENCE_STALE_MS). This is a
   *  process-keepalive signal, NOT a liveness verdict — the honest name for
   *  what several surfaces used to emit as `alive` (F6/P-008). */
  heartbeatFresh: boolean;
  /** EI-19407725333778711 — the FORWARD-LOOKING axis: is an active
   *  `loop-<ownerId>` routine going to re-wake this agent on a cadence?
   *  `undefined` = the self-wake leg was not fetched (opt-in) or degraded —
   *  UNKNOWN, never `false`. */
  loopArmed?: boolean;
  /** EI-19407725333778711 — will ANYTHING wake this agent unprompted
   *  (`loop` | `event` | `none`)? `undefined` = not fetched / degraded =
   *  UNKNOWN. `parked` + `none` is a dead member in a healthy costume; see
   *  presence-selfwake.ts for why unknown must never collapse to `none`. */
  selfWake?: SelfWakeSource;
}

export interface ResolveSessionStatesOpts {
  nowMs?: number;
  /** Fill missing heartbeat/stale/host/pid/source from each subject's own
   *  coord_presence row (one point-read per hydrated subject — for the small-N
   *  bare-id callers like the send-miss path, never for whole rosters). */
  hydratePerId?: boolean;
  /** P-005: consult the box-local psu-pty host registry — `parked` + known
   *  non-cup role + no live host ⇒ `ended`. See the header for why opt-in. */
  psuHostAuthority?: boolean;
  /**
   * EI-19407725333778711: also resolve the FORWARD-LOOKING self-wake axis
   * (`loopArmed` / `selfWake`), one extra batched query per call.
   *
   * Opt-in, following the `psuHostAuthority` precedent — but for the opposite
   * reason. That leg is opt-in because it can be WRONG for the wrong cohort;
   * this one is opt-in only because it costs a query that the non-supervisory
   * callers (the coord:send miss path, which asks "will THIS message land
   * now?") have no use for. Every SUPERVISORY surface — fleet:assignments,
   * fleet:status, coord:roster, leader-brief — should pass it, because
   * noticing a stranded member is precisely their job.
   */
  selfWake?: boolean;
  // ── DI seams (unit tests / bounded callers) ──
  fetchWakeabilityFn?: (ids: string[]) => Promise<Map<string, WakeabilitySignals>>;
  fetchSelfWakeFn?: (ids: string[]) => Promise<Map<string, SelfWakeSignals>>;
  fetchRecordedLiveFn?: (ids: string[]) => Promise<Set<string>>;
  probePidFn?: (r: { host?: string | null; pid?: number | null }) => boolean | null;
  findHostFn?: (ownerId: string) => unknown | null;
  getPresenceFn?: (
    ownerId: string,
  ) => Promise<{
    heartbeatAt: string;
    stale: boolean;
    host: string | null;
    pid: number | null;
    source: string;
  } | null>;
}

/** PURE: one subject's verdict from already-fetched signals — the single place
 *  the legs meet deriveSessionState. Exported for the parity test (P-001). */
export function deriveVerdict(
  subject: LivenessSubject,
  w: WakeabilitySignals,
  recordedLive: ReadonlySet<string>,
  nowMs: number,
  probePidFn: ResolveSessionStatesOpts['probePidFn'] = probeProcessLiveness,
  psuHost?: { enabled: boolean; findHostFn: (ownerId: string) => unknown | null },
  /** EI-19407725333778711: the self-wake signals when the (opt-in) leg ran.
   *  Omitted ⇒ the verdict carries NO loopArmed/selfWake fields at all, which
   *  reads as UNKNOWN — deliberately NOT `none`. */
  selfWake?: SelfWakeSignals,
): LivenessVerdict {
  const hbMs = subject.heartbeatAt ? Date.parse(subject.heartbeatAt) : null;
  const stale =
    subject.stale ??
    (hbMs != null && Number.isFinite(hbMs) ? nowMs - hbMs > PRESENCE_STALE_MS : false);
  // Session-log authority: a not-wakeable owner whose recorded session is live
  // is `recorded` — classified BEFORE the heartbeat/pid path so it is never
  // force-ended (presence-derive-from-session-log P-001; PRESENCE_DEAD_MS note).
  const recordedLiveOnly =
    !w.wakeable && (subject.source === RECORDED_SESSION_SOURCE || recordedLive.has(subject.ownerId));
  let sessionState: SessionState;
  if (recordedLiveOnly) {
    sessionState = 'recorded';
  } else {
    sessionState = deriveSessionState({
      stale: !!stale,
      wakeable: w.wakeable,
      liveTurn: w.liveTurn,
      hardStale: isHardStale(hbMs, nowMs),
      pidConfirmedDead: probePidFn({ host: subject.host, pid: subject.pid }) === false,
      claimsHeld: !!subject.claimsHeld,
    });
    // P-005: the psu-host authority leg — a `parked` verdict for a known
    // non-cup cohort with no live psu host on this box is a dead host that
    // stranded its heartbeat + wake-await.
    if (
      psuHost?.enabled &&
      sessionState === 'parked' &&
      subject.agentRole != null &&
      subject.agentRole !== 'cup' &&
      psuHost.findHostFn(subject.ownerId) == null
    ) {
      sessionState = 'ended';
    }
  }
  return {
    ownerId: subject.ownerId,
    sessionState,
    wakeable: w.wakeable,
    liveTurn: w.liveTurn,
    confirmLiveness: needsLivenessConfirmation(sessionState),
    heartbeatFresh: !stale,
    // Spread-when-present, never a `?? false` default: an absent self-wake leg
    // must stay ABSENT so a reader cannot mistake "not fetched" for "nothing
    // will wake this agent" (presence-selfwake.ts § Why `unknown` is not `none`).
    ...(selfWake ? { loopArmed: selfWake.loopArmed, selfWake: selfWake.selfWake } : {}),
  };
}

/**
 * THE liveness oracle: batched verdicts for a set of subjects. Owners with no
 * wakeability signal (a degraded fetch) get NO entry — the caller keeps its
 * legacy "state unknown" behavior, exactly like the per-site fetches did.
 * Fail-soft is the CALLER's choice (wrap in withBoundedTimeout / .catch) so
 * reapers that must not act on partial data can propagate instead.
 */
export async function resolveSessionStates(
  subjects: readonly LivenessSubject[],
  opts: ResolveSessionStatesOpts = {},
): Promise<Map<string, LivenessVerdict>> {
  const out = new Map<string, LivenessVerdict>();
  if (subjects.length === 0) return out;
  const nowMs = opts.nowMs ?? Date.now();
  const fetchWake = opts.fetchWakeabilityFn ?? fetchWakeability;
  const fetchRecorded = opts.fetchRecordedLiveFn ?? recordedLiveOwnerIds;
  const probePidFn = opts.probePidFn ?? probeProcessLiveness;
  const findHostFn = opts.findHostFn ?? findLiveHost;

  let hydrated: readonly LivenessSubject[] = subjects;
  if (opts.hydratePerId) {
    const getPresenceFn = opts.getPresenceFn ?? getPresence;
    hydrated = await Promise.all(
      subjects.map(async (s) => {
        if (s.heartbeatAt != null || s.stale != null) return s;
        try {
          const p = await getPresenceFn(s.ownerId);
          if (!p) return s;
          return {
            ...s,
            heartbeatAt: p.heartbeatAt,
            stale: p.stale,
            host: s.host ?? p.host,
            pid: s.pid ?? p.pid,
            source: s.source ?? p.source,
          };
        } catch {
          return s; // hydration is best-effort — a store hiccup never blocks the verdict
        }
      }),
    );
  }

  const ids = hydrated.map((s) => s.ownerId);
  const fetchSelf = opts.fetchSelfWakeFn ?? fetchSelfWake;
  const [wakeability, recordedLive, selfWake] = await Promise.all([
    fetchWake(ids),
    // Recorded-session authority is an ENRICHMENT leg — best-effort by design
    // (adv_sessions may lag/miss); a failure degrades to "no recorded rescue",
    // never fails the verdict batch.
    fetchRecorded(ids).catch(() => new Set<string>()),
    // Self-wake is likewise an ENRICHMENT leg: a failure degrades every subject
    // to "self-wake unknown" (the fields are simply absent) and never fails the
    // batch — a supervisor losing one column must not cost it the whole roster.
    opts.selfWake === true
      ? fetchSelf(ids).catch(() => new Map<string, SelfWakeSignals>())
      : Promise.resolve(new Map<string, SelfWakeSignals>()),
  ]);
  const psuHost = { enabled: opts.psuHostAuthority === true, findHostFn };
  for (const s of hydrated) {
    const w = wakeability.get(s.ownerId);
    if (!w) continue; // no signal (degraded fetch / federated id) — state unknown
    out.set(
      s.ownerId,
      deriveVerdict(s, w, recordedLive, nowMs, probePidFn, psuHost, selfWake.get(s.ownerId)),
    );
  }
  return out;
}

/**
 * P-005 shared helper: reconcile ALREADY-derived per-agent session states with
 * the psu-host authority — the exact rule fleet:leader-brief used to apply
 * privately (reconcilePsuHostLiveness), now exported from the oracle so any
 * surface whose cohort is known-psu-hosted applies the SAME rule. Mutates in
 * place and returns the list.
 *
 * `liveTurn` is derived from recent agent_activity, not from the host process
 * itself. A stale directed wake can therefore leave a dead owner looking
 * `live` after its psu host has exited. For a known non-cup cohort, the local
 * psu host is the stronger authority for both `live` and `parked`; `recorded`
 * remains exempt because it is the session-log authority for a session that has
 * not yet registered an inbox-wake await.
 */
export function applyPsuHostAuthority<
  T extends { agentId: string; sessionState?: SessionState | null; alive?: boolean },
>(
  agents: T[],
  agentRoles: ReadonlyMap<string, string | null>,
  findHostFn: (ownerId: string) => unknown | null = findLiveHost,
): T[] {
  for (const agent of agents) {
    const role = agentRoles.get(agent.agentId);
    if (role == null || role === 'cup') continue;
    if (
      (agent.sessionState === 'live' || agent.sessionState === 'parked') &&
      findHostFn(agent.agentId) == null
    ) {
      agent.sessionState = 'ended';
      if ('alive' in agent) agent.alive = false;
    }
  }
  return agents;
}
