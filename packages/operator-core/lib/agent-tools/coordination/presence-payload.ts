/**
 * presence-payload.ts — the two-lane partition of a coord:presence roster row
 * (presence-v2-2026-06-14 P-009 / D-005 / D-006).
 *
 * Every enriched roster row is split into three lanes:
 *
 *   - IDENTITY  — stable for the life of the session (ownerId, label, role,
 *                 host, model, hive, started_at, …). Byte-stable across reads,
 *                 so it forms the cacheable PREFIX of the read-once snapshot
 *                 (D-006: prompt caching matches prefixes — the win is the
 *                 identity block never churning).
 *   - STATE     — discrete transitions peers ACT on (intent, plan, files,
 *                 claimed lane, blocked-on/await, wakeMode, revoked). IDENTITY ∪
 *                 STATE is the DELTA-ELIGIBLE payload (D-005 lane 1): a change in
 *                 either is what rides [coord+N] as a delta (identity rarely
 *                 changes, but a re-host / role-resolve legitimately can).
 *   - LIVENESS  — continuous signals (lastActiveSecAgo, stale). Snapshot + SSE
 *                 ONLY; NEVER injected as a [coord+N] delta (D-005 lane 2 / D-008
 *                 — injecting heartbeat churn is exactly the notify-storm we
 *                 guard against). Recomputed fresh each read.
 *
 * Byte-stability (D-006): the raw per-row timestamps (heartbeatAt / lastActiveAt)
 * are kept OUT of the emitted payload — heartbeat especially churns every read
 * (the 60s keepalive bumps it) and would break the byte-stable prefix. Their
 * signal survives as the derived `lastActiveSecAgo` (a LIVENESS scalar) plus the
 * single roster-level `as_of` stamp (P-005). startedAt is a timestamp but is
 * stable per session, so it stays in IDENTITY.
 *
 * P-008's delta channel diffs `deltaEligibleProjection` (identity+state, NO
 * liveness) so liveness churn never produces a delta; the snapshot read emits
 * `toStableRosterRow` (identity+state + the one liveness scalar worth carrying).
 * The guards in presence-payload.test.ts assert the partition covers every
 * emitted field, the lanes are disjoint, and liveness stays out of the delta
 * lane.
 */

import type { UnifiedPresenceRecord } from './federated-presence';
import type { PresenceTier1Joins } from './presence-tier1';
import type { SessionState } from './presence-wakeability';

/**
 * The self-referential placeholder a presence declare writes when an agent is
 * live but has declared no real intent (see the coord-hook + locks/enrich-busy).
 * It is a NON-signal on the roster — "(active — see coord:presence…)" read AS an
 * intent is circular and misleads the Queen/peers into thinking a real intent
 * exists. `toStableRosterRow` normalizes it to `null` on the READ side (P-004) so
 * the roster shows an honest "no declared intent" without touching the write path
 * (enrich-busy still relies on the written sentinel to detect the no-intent case).
 * Canonical here so every reader shares ONE string (was duplicated in enrich-busy).
 */
export const PLACEHOLDER_INTENT = '(active — see coord:presence for current work)';

/**
 * A coord:presence roster row at the point it is emitted: the unified
 * local+federated record, plus the derived `lastActiveSecAgo`, the coordinator
 * wakeability signals (`sessionState` / `wakeable`, P-001), and the (local-only)
 * Tier-1 join scalars from `mergeTier1`. All are optional so a raw (un-enriched)
 * stale record — or a federated row with no local wakeability join — is also a
 * valid input; `partitionPresenceRow` reads every field defensively.
 */
export type RosterRow = UnifiedPresenceRecord &
  Partial<
    {
      lastActiveSecAgo: number | null;
      /** Derived from lastActiveSecAgo: the declared intent is stale (the agent
       *  is process-alive but genuinely idle past the threshold). null = unknown. */
      intentStale: boolean | null;
      /** P-001: live | parked | ended (null for a federated/unknown row). */
      sessionState: SessionState | null;
      /** P-001: a live inbox-wake await exists → a wake will be delivered. */
      wakeable: boolean | null;
      /** This session is CURRENTLY on the desktop — a live OS window on the
       *  user's screen (derived live via wmctrl + adv_sessions.window_id; owner
       *  decision 2026-06-29). true ⇒ hard-exempt from the idle-session reaper
       *  and the target for "assign these to the agent on the desktop". null for a
       *  federated/unknown row (its windows live on its home box). */
      onDesktop: boolean | null;
      /** A human is CURRENTLY viewing this session's terminal in the operator
       *  web/Tauri PTY panel (pty-viewer-heartbeat.ts). true ⇒ hard-exempt from the
       *  idle-session reaper even with NO OS window — the deferred sibling of
       *  onDesktop for the panel-viewed case. null for a federated/unknown row. */
      viewerAttached: boolean | null;
      /** named-su-agent-fleets P-005: the agent's named-fleet slug (the SOFT
       *  coord_presence membership label, joined in via fetchPresenceFleet — it does
       *  NOT ride the base PresenceRecord the way hive_slug does). Absent ⇒ no fleet. */
      fleetSlug: string | null;
      /** named-su-agent-fleets P-005: role within the fleet ('leader' | 'member'). */
      fleetRole: string | null;
    } & PresenceTier1Joins
  >;

/** IDENTITY lane — stable for the life of the session. */
export const PRESENCE_IDENTITY_FIELDS = [
  'ownerId',
  'ownerLabel',
  'workspaceId',
  'source',
  'host',
  'pid',
  'startedAt',
  'agentRole',
  'hiveSlug',
  'fleetSlug',
  'fleetRole',
  'model',
  'userId',
  'federated',
  'devicePubkey',
  'harnessSlug',
] as const satisfies readonly (keyof RosterRow)[];

/** STATE lane — discrete transitions; the delta-eligible payload (with IDENTITY). */
export const PRESENCE_STATE_FIELDS = [
  'intent',
  'currentPlanSlug',
  'currentView',
  'currentFiles',
  'claimedItems',
  'awaitingEvent',
  'awaitingEventKey',
  'awaitingNote',
  'wakeMode',
  'revoked',
] as const satisfies readonly (keyof RosterRow)[];

/** LIVENESS lane — continuous; snapshot + SSE only, NEVER injected as a delta.
 *  `sessionState` / `wakeable` (P-001) live here, not in the delta-eligible set,
 *  because they are derived from continuous liveness signals (heartbeat freshness
 *  + activity recency) — a live↔parked flip on every turn-park is exactly the
 *  churn the delta channel must not carry. A coordinator reads them from the
 *  snapshot (coord:presence), which is their use case. */
export const PRESENCE_LIVENESS_FIELDS = [
  'lastActiveSecAgo',
  'intentStale',
  'stale',
  'sessionState',
  'wakeable',
  // Derived live from the OS window list each read — a continuous external
  // signal, so it lives in LIVENESS (snapshot-only, never a [coord+N] delta:
  // open/close-window churn must not ride the byte-stable delta channel).
  'onDesktop',
  // Same lane as onDesktop: a continuous external signal (a human watching the PTY
  // panel), so it's snapshot-only and never rides the byte-stable [coord+N] delta.
  'viewerAttached',
] as const satisfies readonly (keyof RosterRow)[];

/**
 * Raw per-row timestamps deliberately DROPPED from the emitted payload (they
 * churn every read and would break byte-stability). Listed so the coverage
 * guard treats them as intentionally unclassified, not an oversight.
 */
export const PRESENCE_DROPPED_FIELDS = [
  'heartbeatAt',
  'lastActiveAt',
] as const satisfies readonly (keyof RosterRow)[];

/** The delta-eligible field set (D-005 lane 1) = IDENTITY ∪ STATE. A change in
 *  any of these is what may ride [coord+N]; LIVENESS is disjoint and never a
 *  delta. */
export const PRESENCE_DELTA_FIELDS: readonly (keyof RosterRow)[] = [
  ...PRESENCE_IDENTITY_FIELDS,
  ...PRESENCE_STATE_FIELDS,
];

export interface PartitionedPresenceRow {
  /** Stable identity block (byte-stable across reads). */
  identity: Partial<RosterRow>;
  /** Discrete-transition state block (delta-eligible with identity). */
  state: Partial<RosterRow>;
  /** Continuous liveness block (snapshot-only, never a delta). */
  liveness: Partial<RosterRow>;
}

/** Copy the present, defined `fields` of `row` into a fresh object, preserving
 *  the field-set's order (deterministic key order → byte-stable serialization).
 *  A field absent on the row (e.g. a federated row has no `model`) is omitted,
 *  not emitted as `undefined`. */
function pick<K extends keyof RosterRow>(
  row: RosterRow,
  fields: readonly K[],
): Partial<Pick<RosterRow, K>> {
  const out: Partial<Pick<RosterRow, K>> = {};
  for (const k of fields) {
    if (k in row && row[k] !== undefined) {
      (out as Record<K, unknown>)[k] = row[k];
    }
  }
  return out;
}

/** Split a roster row into its identity / state / liveness lanes (D-005/D-006). */
export function partitionPresenceRow(row: RosterRow): PartitionedPresenceRow {
  return {
    identity: pick(row, PRESENCE_IDENTITY_FIELDS),
    state: pick(row, PRESENCE_STATE_FIELDS),
    liveness: pick(row, PRESENCE_LIVENESS_FIELDS),
  };
}

/**
 * The delta-eligible projection (P-008 input): identity + state ONLY. P-008
 * diffs this between snapshots so liveness churn never produces a [coord+N]
 * delta. Key order is identity-then-state → deterministic.
 */
export function deltaEligibleProjection(row: RosterRow): Partial<RosterRow> {
  const { identity, state } = partitionPresenceRow(row);
  return { ...identity, ...state };
}

/**
 * The lean, byte-stable roster row the coord:presence tool emits: the
 * delta-eligible projection (identity + state) plus the one liveness scalar
 * worth carrying in a snapshot, `lastActiveSecAgo`. Its identity+state portion
 * is byte-identical across reads of an unchanged agent (no raw timestamps, one
 * roster `as_of`); only `lastActiveSecAgo` moves, and that is the liveness lane
 * which the delta channel ignores. `stale` is conveyed structurally (the active
 * vs stale array), so it is not re-emitted per row.
 */
export function toStableRosterRow(row: RosterRow): Record<string, unknown> {
  const { identity, state, liveness } = partitionPresenceRow(row);
  const out: Record<string, unknown> = {
    ...identity,
    ...state,
    lastActiveSecAgo: (liveness.lastActiveSecAgo as number | null | undefined) ?? null,
    // Stale-ownership signal: TRUE ⇒ this agent's declared intent/lane is NOT being
    // actively progressed (idle past the threshold though its process still beats),
    // so a reader must not treat its work as "handled". Always present for a reader.
    intentStale: (liveness.intentStale as boolean | null | undefined) ?? null,
    // P-001: the coordinator's "can I hand this agent work?" signals. Emitted as
    // explicit nulls for a federated/unknown row (its await lives on its home
    // instance, so we cannot derive them locally) rather than omitted, so the
    // field is always present for a reader.
    sessionState: (liveness.sessionState as SessionState | null | undefined) ?? null,
    wakeable: (liveness.wakeable as boolean | null | undefined) ?? null,
    // "On the desktop right now" — always emitted (null when un-derived, e.g. a
    // federated row), so a reader can always filter "agents on the desktop".
    onDesktop: (liveness.onDesktop as boolean | null | undefined) ?? null,
    // "A human is viewing this session's PTY panel right now" — always emitted (null
    // when un-derived, e.g. a federated row), so a reader can always filter it.
    viewerAttached: (liveness.viewerAttached as boolean | null | undefined) ?? null,
  };
  // P-004: the self-referential placeholder intent is a non-signal — normalize it to
  // null so a reader (and the Queen) never mistakes it for a real declared intent.
  if (out.intent === PLACEHOLDER_INTENT) out.intent = null;
  return out;
}
