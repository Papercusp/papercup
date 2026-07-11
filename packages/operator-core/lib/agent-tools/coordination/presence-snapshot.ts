/**
 * presence-snapshot.ts — the shared hive-scoped roster SNAPSHOT builder
 * (presence-v2-2026-06-14). One place assembles the byte-stable read-once
 * snapshot so the coord:presence tool AND the coord:inbox re-bootstrap
 * (P-010 / D-007) read the SAME roster, scoped the SAME way — never a
 * divergent second implementation.
 *
 *   resolvePresenceScope  — ctx (+ optional args) → the effective read scope
 *                           (hive default via the caller's harness→home hive;
 *                           SU/unmapped → workspace fallback | workspace | all).
 *   assemblePresenceSnapshot — run the scope: list local + federated presence,
 *                           GC long-dead rows, Tier-1 enrich the active locals,
 *                           and project each row through the P-009 byte-stable
 *                           `toStableRosterRow`.
 *   renderPresenceRebootstrapBlock — a terse text block for the [coord+N]
 *                           injection that re-establishes a compacted agent's
 *                           roster baseline (P-010).
 */

import { activeWorkspaceId } from '../../workspace-registry';
import { listRecordedLiveSessions } from '../../adv-sessions';
import { listPresence, sweepStalePresence } from './presence';
import { listFederatedPresence } from './federated-presence';
import { reconcileRosterSources, RECORDED_SESSION_SOURCE } from './recorded-sessions';
import { fetchPresenceTier1, mergeTier1, type PresenceTier1Joins } from './presence-tier1';
import { fetchPresenceFleet, type FleetMembership } from './presence-fleet';
import { createHash } from 'node:crypto';
import { toStableRosterRow, deltaEligibleProjection, type RosterRow } from './presence-payload';
import {
  fetchWakeability,
  deriveSessionState,
  isHardStale,
  overrideIntentStaleForSessionState,
  type WakeabilitySignals,
} from './presence-wakeability';
import { deriveContextPressure } from './context-pressure';
import { writeWatermark } from './watermarks';
import { getTxPool, readGranularHolders } from '../locks/su-lock-store';
import { gatherOnDesktopSessions } from '../../desktop-window-liveness';
import { gatherViewerAttachedOwners } from '../../pty-viewer-heartbeat';
import type { Watermark } from '@papercusp/coordination/core';

/** Hard GC threshold: rows whose heartbeat is older than this are dead beyond
 *  any doubt and are swept on read so the roster stays bounded. */
const PRESENCE_GC_MS = 24 * 60 * 60 * 1000;

/** EI-9029: below this size, the re-bootstrap block still inlines a full
 *  per-agent roster (small enough to be cheap AND genuinely readable at a
 *  glance — a fleet/hive roster is small by design, D-002). At or above it
 *  (a workspace-fallback read on a large workspace), inlining every row is
 *  expensive context most sessions never read — deltas ([coord+N]) are
 *  already the steady-state mechanism and carry everything that changes
 *  from here, so the block collapses to a one-line summary + an explicit
 *  on-demand pointer at coord:presence instead of a 40-line dump. */
const REBOOTSTRAP_INLINE_MAX_ROWS = 15;

export interface PresenceScopeArgs {
  scope?: 'hive' | 'workspace' | 'all';
  hive?: string;
  workspace?: string;
}

export interface ResolvedPresenceScope {
  scope: 'hive' | 'workspace' | 'all';
  wsId: string | null;
  potId: string | null;
  scopeNote?: string;
}

export interface PresenceSnapshot {
  as_of: string;
  scope: string;
  hive?: string;
  scope_note?: string;
  /** `wakeable` (P-001) is the count a coordinator should read INSTEAD of
   *  `active` — agents an events:emit / coord:dispatch will actually reach.
   *  `byState` breaks the roster down live | parked | ended. */
  summary: {
    active: number;
    stale: number;
    federated: number;
    wakeable: number;
    /** Agents CURRENTLY on the desktop (a live OS window) — the "assign these to
     *  the agent on the desktop" count, and the reaper's hard-exempt cohort. */
    onDesktop: number;
    /** Agents a human is CURRENTLY viewing in the operator web/Tauri PTY panel
     *  (no OS window) — the reaper's other hard-exempt cohort (pty-viewer-heartbeat.ts). */
    viewerAttached: number;
    byState: { live: number; parked: number; ended: number; recorded: number };
    /** P-007: agents whose context-pressure bucket is 'high' or 'critical' right
     *  now — the fleet-health headline (silent by design: 'ok'/unknown agents are
     *  the common case and aren't counted, mirroring the ambient gauge's own
     *  quiet-below-LOUD philosophy). */
    byContextPressure: { high: number; critical: number };
  };
  /** The ACTIONABLE roster: live + parked + recorded rows (everything a
   *  coordinator can dispatch to / wake) — `ended` rows are NEVER included here
   *  (that full-stale dump was the payload footgun this replaced). A targeted
   *  `owner` read returns the matched row(s) here EVEN IF `ended` (the "inspect /
   *  wake one dead agent" path). Counts for the excluded `ended` rows still live
   *  in `summary.byState.ended`. */
  active: Record<string, unknown>[];
  /** Content ETag over the DELTA-ELIGIBLE projection (identity+state) of the
   *  returned roster — the byte-stable half (D-006), EXCLUDING liveness churn
   *  (heartbeat / lastActiveSecAgo / live↔parked) and `as_of`. Stable across reads
   *  of an unchanged roster. A caller passes it back as `since:` to get a ~100B
   *  `{ unchanged: true }` short-circuit when nothing actionable has changed —
   *  the structural defense against re-polling a 20KB snapshot every turn. */
  etag: string;
}

/**
 * Pure: the content ETag for a roster's DELTA-ELIGIBLE projection (P-006 /
 * presence-tool-hardening). Hashes the identity+state of each row (via
 * `deltaEligibleProjection` — the SAME projection the [coord+N] delta channel
 * diffs, so liveness churn is excluded by construction) plus the scope + hive, so
 * two reads of an unchanged roster produce the SAME etag while ANY identity/state
 * change (intent, plan, claimed lane, await, a row added/removed, a re-host)
 * produces a different one. Rows are already ownerId-sorted by `selectRosterRows`;
 * we sort defensively so the etag is order-independent regardless of caller.
 */
export function computeRosterEtag(
  rows: RosterRow[],
  scope: string,
  potId: string | null,
): string {
  const projected = rows
    .map((r) => deltaEligibleProjection(r))
    .sort((a, b) => String(a.ownerId).localeCompare(String(b.ownerId)));
  const h = createHash('sha1');
  h.update(scope);
  h.update('\0');
  h.update(potId ?? '');
  h.update('\0');
  h.update(JSON.stringify(projected));
  return h.digest('hex').slice(0, 16);
}

/**
 * Resolve the effective read scope (P-004 / D-002). Default = the caller's
 * Hive: explicit `hive` arg wins; else the caller's harness → home Hive. A
 * caller with no Hive (SU/operator, harness '*'/none/unmapped) falls back to
 * workspace scope (recorded in `scopeNote`). ctx is read defensively so an
 * anonymous caller never throws.
 */
export async function resolvePresenceScope(
  ctx: { workspaceId?: string | null; harnessSlug?: string | null } | undefined,
  args: PresenceScopeArgs = {},
): Promise<ResolvedPresenceScope> {
  const c = ctx ?? {};
  const callerWs = args.workspace ?? c.workspaceId ?? null;
  const scope = args.hive ? 'hive' : (args.scope ?? 'hive');
  let hiveFilter: string | null = null;
  let scopeNote: string | undefined;
  if (scope === 'hive') {
    hiveFilter = args.hive ?? null;
    if (!hiveFilter) {
      const harness = c.harnessSlug && c.harnessSlug !== '*' ? c.harnessSlug : null;
      if (harness) {
        try {
          const { potHomeSlugForHarness } = await import('../../hive-federation');
          hiveFilter = await potHomeSlugForHarness(callerWs ?? 'default', harness);
        } catch {
          hiveFilter = null; // best-effort — presence must list even if hive lookup fails
        }
      }
    }
    if (!hiveFilter) scopeNote = 'caller has no Hive (SU/operator or unmapped harness) — fell back to workspace scope';
  }
  // all → no filters; hive+resolved → workspace+hive; hive-without-a-hive / workspace → workspace only.
  // F-M2 (workspace-data-isolation-leaks): a non-'all' scope with no caller workspace
  // used to fall through to wsId=null (= ALL workspaces' roster). Default to the active
  // workspace instead, so only an EXPLICIT scope:'all' is cross-workspace.
  const wsId = scope === 'all' ? null : (callerWs ?? activeWorkspaceId());
  const potId = scope === 'hive' ? hiveFilter : null;
  return { scope, wsId, potId, scopeNote };
}

/**
 * Match a roster row against a targeted `owner` needle for the `owner` lookup —
 * exact ownerId or label, else a substring either-way (the same fuzz
 * coord:dispatch's findPresenceRow + coord:send resolve), so a handle / id prefix
 * still finds the agent. Pure + exported for unit coverage.
 */
export function matchesOwner(r: RosterRow, needle: string): boolean {
  if (!needle) return false;
  const id = String(r.ownerId ?? '');
  const label = String((r as { ownerLabel?: unknown }).ownerLabel ?? '');
  return id === needle || label === needle || (!!id && (id.includes(needle) || needle.includes(id)));
}

/**
 * PURE selection of the RETURNED roster from the full enriched set (extracted so
 * the DEFECT-1 contract unit-tests without PG):
 *   - `owner` set → the matched row(s), INCLUDING an `ended` one (the targeted
 *     "inspect / wake one dead agent" lookup that replaced `include_stale`).
 *   - `owner` absent → every ACTIONABLE row (live | parked | recorded | a
 *     federated/unknown peer), NEVER an `ended` row (the payload-ballooning dead
 *     pile). Sorted by ownerId so the emitted list is byte-stable (D-006).
 */
export function selectRosterRows(rows: RosterRow[], owner?: string): RosterRow[] {
  const picked = owner
    ? rows.filter((r) => matchesOwner(r, owner))
    : rows.filter((r) => r.sessionState !== 'ended');
  return picked.sort((a, b) => String(a.ownerId).localeCompare(String(b.ownerId)));
}

/**
 * Assemble the roster snapshot for a resolved scope. The federated roster
 * (cross-machine peers) is merged in (best-effort — [] on a single box). The
 * GC sweep runs concurrently so it adds no latency and never breaks the read.
 * Active local rows get the Tier-1 enrichment; every row is projected through
 * the P-009 byte-stable `toStableRosterRow` (raw timestamps dropped).
 */
export async function assemblePresenceSnapshot(
  resolved: ResolvedPresenceScope,
  opts: { owner?: string; nowMs?: number; detail?: { coordinationDomain: string } } = {},
): Promise<PresenceSnapshot> {
  const { wsId, potId, scope, scopeNote } = resolved;
  // EI-9454: a `{ owner }` read is a TARGETED point-lookup — it must not pay the
  // whole-roster assembly (see the early filter + sweep skip below).
  const targeted = typeof opts.owner === 'string' && opts.owner.length > 0;
  const [records, federated, recordedLive] = await Promise.all([
    listPresence({ workspaceId: wsId, potSlug: potId }),
    listFederatedPresence({ workspaceId: wsId, potSlug: potId }),
    // The AUTHORITATIVE-session-log leg (P-001): live recorded sessions of ANY
    // CLI not yet self-registered in coord_presence — so a recorded session is
    // visible the instant it launches, never gated on a self-heartbeat. Skipped
    // for an explicit hive scope (adv_sessions carries no hive attribution yet →
    // including it could leak cross-hive agents; P-002 adds hive_slug). Runs for
    // the workspace/all views — the su/operator/admin roster where the gap lives.
    // listRecordedLiveSessions is itself best-effort ([] on DB error).
    potId == null
      ? listRecordedLiveSessions({ workspaceId: wsId })
      : Promise.resolve([] as Awaited<ReturnType<typeof listRecordedLiveSessions>>),
    // Blunt 24h GC of long-dead rows (the pre-existing backstop, still here as a
    // final safety net). NOTE: the READ side additionally excludes `ended` rows from
    // the default payload (`selectRosterRows`) WITHOUT deleting them — that's a
    // display filter, not retention. Actual short-TTL retention is now a SEPARATE
    // scheduled reaper (presence-coord-unification-2026-07-01 P-004, WI-1347 —
    // coordPresenceReaperTick / reapEndedPresenceRows in presence-reaper.ts, hourly),
    // which is wakeability-aware (never reaps a `parked` row, only a genuinely
    // `ended` one past its TTL) and was cleared to ship once the append-only
    // fleet_membership_events ledger (P-002 / WI-1345 / migration 430) landed —
    // fleet-membership history now survives a coord_presence row's deletion.
    // EI-9454: the sweep (a maintenance DELETE) runs on the FULL-roster read only —
    // a targeted { owner } lookup is the hot "is this agent alive?" point-read and
    // must not queue a write behind a starved pool. The hourly presence-reaper and
    // every default read keep the sweep cadence, so retention is unaffected.
    targeted ? Promise.resolve(0) : sweepStalePresence(PRESENCE_GC_MS).catch(() => 0),
  ]);
  // Reconcile the two liveness sources: a fresh presence row wins; a live
  // session-log record supersedes a STALE presence row (so a resumed-but-idle
  // session whose old heartbeat went stale is still surfaced, not shadowed); an
  // owner with only a live record gets a synthesized 'recorded' row. CLI-agnostic.
  // P-006 (cross-machine-coord-parity): LOCAL WINS on ownerId collision — a
  // session homed HERE must never be shadowed (or duplicated) by its own
  // federated echo, and a remote peer claiming a local ownerId is dropped.
  const localOwnerIds = new Set(records.map((r) => r.ownerId));
  const fedDeduped = federated.filter((f) => !localOwnerIds.has(f.ownerId));
  const all: RosterRow[] = reconcileRosterSources([...records, ...fedDeduped], recordedLive);
  // EI-9454 (targeted-lookup cost): when `owner` is set, filter EARLY — the base
  // rows already carry ownerId+ownerLabel (all matchesOwner needs), so the matched
  // row(s) are known BEFORE the enrichment fan-out. Everything downstream (the 5
  // batch joins, the per-row projection, the opt-in detail lock join) then runs
  // for the 1-2 matched ids instead of the whole roster — the documented
  // "targeted lookup" stops paying the O(roster) assembly that made it time out
  // under fleet load (~67 sessions → 55s/300s aborts). selectRosterRows applies
  // the SAME predicate at the end (idempotent), so the selected rows are
  // byte-identical to the late-filter result; summary counts on a targeted read
  // now describe the matched subset (the rows actually returned), not the whole
  // roster.
  const scoped = targeted ? all.filter((r) => matchesOwner(r, opts.owner as string)) : all;
  const active = scoped.filter((r) => !r.stale);
  const stale = scoped.filter((r) => r.stale);
  const now = opts.nowMs ?? Date.now();
  const isFederated = (r: RosterRow) => r.federated === true;
  // Tier-1 enrichment stays ACTIVE-only (cost, P-003); wakeability is fetched for
  // BOTH active AND stale locals — a stale (heartbeat>10min) row with a live await
  // is `parked`, not gone, and that is exactly the dispatch target P-001 surfaces.
  const localActiveIds = active.filter((r) => !isFederated(r)).map((r) => r.ownerId);
  // EI-9454: derive from `scoped` (not `all`) so the wakeability + fleet joins
  // also collapse to the matched id(s) on a targeted read.
  const localAllIds = scoped.filter((r) => !isFederated(r)).map((r) => r.ownerId);
  let joins = new Map<string, PresenceTier1Joins>();
  let wakeability = new Map<string, WakeabilitySignals>();
  let onDesktopOwners = new Set<string>();
  let viewerAttachedOwners = new Set<string>();
  // Named-fleet membership (P-005): the SOFT coord_presence label, joined in per-owner
  // (it does NOT ride the base PresenceRecord like hive_slug). Fetched for the WHOLE
  // local roster (active + stale) so a parked fleet member still shows its fleet.
  let fleet = new Map<string, FleetMembership>();
  await Promise.all([
    // each best-effort + independent — presence must list even if any join fails.
    fetchPresenceTier1(localActiveIds)
      .then((m) => {
        joins = m;
      })
      .catch(() => {}),
    fetchWakeability(localAllIds)
      .then((m) => {
        wakeability = m;
      })
      .catch(() => {}),
    // On-desktop (live OS window) owners — best-effort, box-local (empty on a
    // headless box). Independent of the other joins so a wmctrl hiccup never
    // affects wakeability/tier-1, and vice-versa.
    gatherOnDesktopSessions()
      .then((s) => {
        onDesktopOwners = s.owners;
      })
      .catch(() => {}),
    // PTY-panel viewer-attach owners (pty-viewer-heartbeat.ts) — the no-OS-window
    // sibling of on-desktop. Best-effort + independent so a DB hiccup never affects
    // the other joins.
    gatherViewerAttachedOwners()
      .then((s) => {
        viewerAttachedOwners = s;
      })
      .catch(() => {}),
    // Named-fleet membership (P-005) — best-effort + independent of the other joins.
    fetchPresenceFleet(localAllIds)
      .then((m) => {
        fleet = m;
      })
      .catch(() => {}),
  ]);

  /** Attach the P-001 wakeability signals. A federated/unknown row has no local
   *  entry → sessionState/wakeable stay absent (emitted as null by toStableRosterRow). */
  const nowMs = Date.now();
  const withWakeability = (r: RosterRow): RosterRow => {
    const w = wakeability.get(r.ownerId);
    if (!w) return r;
    // A session-log-derived row (P-001) is AUTHORITATIVELY live (its adv_sessions
    // ended_at IS NULL) but, until it self-registers a coord await, has no
    // inbox-wake → it is `recorded` (alive, not inbox-wake-dispatchable), NOT
    // `ended` (which means dead/relaunch). A recorded session that HAS begun
    // registering (a live await exists → wakeable) derives normally below.
    const recordedLiveOnly = r.source === RECORDED_SESSION_SOURCE && !w.wakeable;
    // fleet-liveness-zombie-await-2026-07-07: a reboot/SIGKILL leaves a live
    // wake-await, so a dead row would otherwise stay `parked`; the DEAD-ceiling
    // check forces an hour-cold heartbeat to `ended` even while wakeable.
    const hardStale = isHardStale(r.heartbeatAt ? Date.parse(r.heartbeatAt) : null, nowMs);
    const sessionState: RosterRow['sessionState'] = recordedLiveOnly
      ? 'recorded'
      : deriveSessionState({ stale: !!r.stale, wakeable: w.wakeable, liveTurn: w.liveTurn, hardStale });
    return {
      ...r,
      wakeable: w.wakeable,
      sessionState,
      // EI-9262: sessionState (wakeability + activity end-marker) converges to
      // parked/ended far faster than the 30-minute intentStale activity clock —
      // the instant it does, the declared intent must read as unreliable too, so
      // a reader never sees a fresh-looking "still working on X" for an agent
      // that has already stopped taking turns.
      intentStale: overrideIntentStaleForSessionState(r.intentStale ?? null, sessionState),
    };
  };

  /** Attach the on-desktop flag for LOCAL rows (a federated row's windows live on
   *  its home box → leave it null/unknown, like sessionState). */
  const withOnDesktop = (r: RosterRow): RosterRow =>
    isFederated(r) ? r : { ...r, onDesktop: onDesktopOwners.has(r.ownerId) };

  /** Attach the PTY-panel viewer flag for LOCAL rows (a federated row's viewers live
   *  on its home box → leave it null/unknown, like onDesktop). */
  const withViewerAttached = (r: RosterRow): RosterRow =>
    isFederated(r) ? r : { ...r, viewerAttached: viewerAttachedOwners.has(r.ownerId) };

  /** P-007: attach the coarse context-pressure bucket, derived live from the row's
   *  own (contextTokens, compactionLimit) — no extra query, these already ride
   *  PresenceRecord (watchdog-cached). A federated row carries no local estimate →
   *  leave it null/unknown, like onDesktop/viewerAttached. */
  const withContextPressure = (r: RosterRow): RosterRow =>
    isFederated(r)
      ? r
      : { ...r, contextPressure: deriveContextPressure(r.contextTokens, r.compactionLimit) };

  /** Attach the P-005 named-fleet membership. An agent in no fleet (or a federated
   *  row with no local coord_presence) has no entry → fleetSlug/fleetRole stay absent
   *  (toStableRosterRow emits them only when present, so no null spam for non-members). */
  const withFleet = (r: RosterRow): RosterRow => {
    const f = fleet.get(r.ownerId);
    return f ? { ...r, fleetSlug: f.fleetSlug, fleetRole: f.fleetRole } : r;
  };

  const activeEnriched = mergeTier1(active, joins, now)
    .map(withWakeability)
    .map(withOnDesktop)
    .map(withViewerAttached)
    .map(withContextPressure)
    .map(withFleet);
  const staleEnriched = stale.map((r) =>
    withFleet(withContextPressure(withViewerAttached(withOnDesktop(withWakeability(r as RosterRow))))),
  );

  // The FULL enriched roster (fresh-heartbeat + stale), each carrying its derived
  // sessionState. What we RETURN is a filtered view of it:
  //   - a targeted `owner` read → the matched row(s), INCLUDING an `ended` one — the
  //     "inspect / wake ONE dead agent" path that replaced the include_stale full dump.
  //   - a default read → every ACTIONABLE row (live | parked | recorded | a
  //     federated/unknown peer), but NEVER an `ended` row (the dead-row pile that
  //     ballooned the payload; its count still surfaces in summary.byState.ended).
  // Ordered by ownerId so the emitted list stays byte-stable (D-006).
  const fullEnriched = [...activeEnriched, ...staleEnriched];
  const selected = selectRosterRows(fullEnriched, opts.owner);
  // P-006: the delta-eligible ETag (identity+state) for the `since:` short-circuit,
  // computed from the SELECTED rows so it matches EXACTLY what this read returns.
  const etag = computeRosterEtag(selected, scope, potId);
  let activeRows = selected.map(toStableRosterRow);

  // P-011 include_detail: the heavy Tier-2/3 field — held files — lives in the
  // SEPARATE papercusp_su lock DB, so it is fetched ONLY when asked (opt-in,
  // fail-soft) and merged onto the lean rows; never on the default read path
  // (the lean default stays the org-PG-only Tier-1, P-003). Await/handoff/
  // escalation detail keeps its dedicated tools (events:* / coord:inbox) rather
  // than being duplicated into this org-PG read.
  if (opts.detail) {
    const held = await fetchPresenceHeldFiles(localActiveIds, opts.detail.coordinationDomain);
    activeRows = activeRows.map((r) => {
      const files = held.get(r.ownerId as string);
      return files && files.length ? { ...r, heldFiles: files } : r;
    });
  }

  // P-001 summary: count wakeable agents + the live/parked/ended breakdown across
  // the WHOLE roster (active + stale) — `wakeable` is the headline a coordinator
  // reads instead of `active`, and `byState` separates the dispatchable (parked)
  // from the busy (live) and the dead (ended).
  const byState = { live: 0, parked: 0, ended: 0, recorded: 0 };
  const byContextPressure = { high: 0, critical: 0 };
  let wakeable = 0;
  let onDesktop = 0;
  let viewerAttached = 0;
  for (const r of [...activeEnriched, ...staleEnriched]) {
    if (r.wakeable === true) wakeable += 1;
    if (r.onDesktop === true) onDesktop += 1;
    if (r.viewerAttached === true) viewerAttached += 1;
    if (r.contextPressure === 'high') byContextPressure.high += 1;
    else if (r.contextPressure === 'critical') byContextPressure.critical += 1;
    const state = r.sessionState;
    if (state === 'live' || state === 'parked' || state === 'ended' || state === 'recorded') {
      byState[state] += 1;
    }
  }

  return {
    as_of: new Date(now).toISOString(),
    scope,
    ...(potId ? { hive: potId } : {}),
    ...(scopeNote ? { scope_note: scopeNote } : {}),
    summary: {
      active: active.length,
      stale: stale.length,
      // EI-9454: on a targeted read the count matches the returned subset (like
      // active/stale above); the default read keeps the whole-roster count.
      federated: targeted ? scoped.filter((r) => r.federated === true).length : federated.length,
      wakeable,
      onDesktop,
      viewerAttached,
      byState,
      byContextPressure,
    },
    active: activeRows,
    etag,
  };
}

/**
 * Pure: group granular (file) lock holders into per-owner held-file lists,
 * restricted to the roster's ownerIds. Root-node ('') holds are skipped (they
 * are tree-wide intents, not a file), and each list is sorted for byte-stability.
 */
export function groupHeldFilesByOwner(
  holders: Array<{ owner: string; node: string }>,
  ownerIds: Set<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of holders) {
    if (!ownerIds.has(h.owner) || !h.node) continue;
    const arr = out.get(h.owner) ?? [];
    arr.push(h.node);
    out.set(h.owner, arr);
  }
  for (const [k, v] of out) out.set(k, v.sort());
  return out;
}

/**
 * IO seam (P-011 / include_detail): read the live file-lock holders from the SU
 * lock store (the SEPARATE papercusp_su DB) and group them per owner. Fail-soft
 * → empty map: presence must render even if that store is unreachable, and this
 * cross-DB query is OPT-IN (only under include_detail), never on the lean path.
 */
export async function fetchPresenceHeldFiles(
  ownerIds: string[],
  coordinationDomain: string,
): Promise<Map<string, string[]>> {
  if (ownerIds.length === 0) return new Map();
  try {
    const holders = await readGranularHolders(getTxPool(), coordinationDomain);
    return groupHeldFilesByOwner(holders, new Set(ownerIds));
  } catch {
    return new Map();
  }
}

/**
 * Render a terse re-bootstrap block for the [coord+N] injection (P-010): one
 * line per active agent — `<label> [<role>] <intent> (<plan>)` — under a header
 * that tells the agent its lost roster baseline is restored and to resume
 * tailing deltas. Pure (snapshot in → string out) so it is unit-testable.
 *
 * EI-9029: at/above REBOOTSTRAP_INLINE_MAX_ROWS active agents, per-row detail
 * is dropped in favor of a compact byState summary + an explicit on-demand
 * pointer — a 40+-line roster dump was being re-paid on every compaction in
 * a long session regardless of whether that turn ever consulted it; deltas
 * ([coord+N]) already carry what changes from here.
 */
export function renderPresenceRebootstrapBlock(snap: PresenceSnapshot): string {
  const total = snap.summary.active;
  const header =
    `[presence ⟲ ${total}] roster re-read after context compaction — ` +
    `baseline restored, tail [coord+N] deltas from here (as_of ${snap.as_of})`;

  if (total >= REBOOTSTRAP_INLINE_MAX_ROWS) {
    const { live, parked, ended, recorded } = snap.summary.byState;
    const stateBits = [
      live ? `${live} live` : null,
      parked ? `${parked} parked` : null,
      ended ? `${ended} ended` : null,
      recorded ? `${recorded} recorded` : null,
    ].filter((b): b is string => b !== null);
    const stateNote = stateBits.length ? ` (${stateBits.join(', ')})` : '';
    return (
      `${header}\n` +
      `${total} agents active${stateNote} — not inlined (>=${REBOOTSTRAP_INLINE_MAX_ROWS}); ` +
      `fetch the full roster on demand via coord:presence if you need it.`
    );
  }

  const lines = snap.active.map((r) => {
    const label = String(r.ownerLabel ?? r.ownerId ?? '?');
    const role = r.agentRole ? `[${String(r.agentRole)}]` : '[—]';
    const intent = r.intent ? String(r.intent) : '';
    const plan = r.currentPlanSlug ? ` (${String(r.currentPlanSlug)})` : '';
    return `${label} ${role} ${intent}${plan}`.trimEnd();
  });
  return [header, ...lines].join('\n');
}

/**
 * P-010 re-bootstrap-on-compaction (D-007). If the agent's cursor carries a
 * pending re-bootstrap (its cached roster baseline was lost to a context
 * compaction / fresh resume while this durable cursor kept advancing), build the
 * snapshot block + clear the flag ONCE, so the agent re-establishes its baseline
 * before trusting deltas and is never re-injected on later turns. Returns the
 * block, or null when no re-bootstrap is pending. `build` runs BEFORE the clear,
 * so a transient build failure leaves the flag set to retry next turn.
 *
 * The caller passes the already-read watermark (it reads it concurrently with
 * the inbox), so this adds no extra read on the common (no-flag) path.
 */
export async function consumePresenceRebootstrap(
  ownerId: string,
  wm: Pick<Watermark, 'snapshot_rebootstrap_pending'>,
  build: () => Promise<string>,
): Promise<string | null> {
  if (!wm.snapshot_rebootstrap_pending) return null;
  const block = await build();
  await writeWatermark(ownerId, { snapshot_rebootstrap_pending: false });
  return block;
}
