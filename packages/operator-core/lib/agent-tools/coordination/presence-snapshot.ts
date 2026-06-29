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
import { toStableRosterRow, type RosterRow } from './presence-payload';
import { fetchWakeability, deriveSessionState, type WakeabilitySignals } from './presence-wakeability';
import { writeWatermark } from './watermarks';
import { getTxPool, readGranularHolders } from '../locks/su-lock-store';
import { gatherOnDesktopSessions } from '../../desktop-window-liveness';
import { gatherViewerAttachedOwners } from '../../pty-viewer-heartbeat';
import type { Watermark } from '@papercusp/coordination/core';

/** Hard GC threshold: rows whose heartbeat is older than this are dead beyond
 *  any doubt and are swept on read so the roster stays bounded. */
const PRESENCE_GC_MS = 24 * 60 * 60 * 1000;

/** Cap the rows rendered into the re-bootstrap injection block — the hive
 *  roster is small by design (D-002), but bound it so a workspace-fallback read
 *  can't balloon the inject; overflow points at coord:presence. */
const REBOOTSTRAP_MAX_ROWS = 40;

export interface PresenceScopeArgs {
  scope?: 'hive' | 'workspace' | 'all';
  hive?: string;
  workspace?: string;
}

export interface ResolvedPresenceScope {
  scope: 'hive' | 'workspace' | 'all';
  wsId: string | null;
  hiveId: string | null;
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
  };
  active: Record<string, unknown>[];
  stale?: Record<string, unknown>[];
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
          const { hiveHomeSlugForHarness } = await import('../../hive-federation');
          hiveFilter = await hiveHomeSlugForHarness(callerWs ?? 'default', harness);
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
  const hiveId = scope === 'hive' ? hiveFilter : null;
  return { scope, wsId, hiveId, scopeNote };
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
  opts: { includeStale?: boolean; nowMs?: number; detail?: { coordinationDomain: string } } = {},
): Promise<PresenceSnapshot> {
  const { wsId, hiveId, scope, scopeNote } = resolved;
  const [records, federated, recordedLive] = await Promise.all([
    listPresence({ workspaceId: wsId, hiveSlug: hiveId }),
    listFederatedPresence({ workspaceId: wsId, hiveSlug: hiveId }),
    // The AUTHORITATIVE-session-log leg (P-001): live recorded sessions of ANY
    // CLI not yet self-registered in coord_presence — so a recorded session is
    // visible the instant it launches, never gated on a self-heartbeat. Skipped
    // for an explicit hive scope (adv_sessions carries no hive attribution yet →
    // including it could leak cross-hive agents; P-002 adds hive_slug). Runs for
    // the workspace/all views — the su/operator/admin roster where the gap lives.
    // listRecordedLiveSessions is itself best-effort ([] on DB error).
    hiveId == null
      ? listRecordedLiveSessions({ workspaceId: wsId })
      : Promise.resolve([] as Awaited<ReturnType<typeof listRecordedLiveSessions>>),
    sweepStalePresence(PRESENCE_GC_MS).catch(() => 0),
  ]);
  // Reconcile the two liveness sources: a fresh presence row wins; a live
  // session-log record supersedes a STALE presence row (so a resumed-but-idle
  // session whose old heartbeat went stale is still surfaced, not shadowed); an
  // owner with only a live record gets a synthesized 'recorded' row. CLI-agnostic.
  const all: RosterRow[] = reconcileRosterSources([...records, ...federated], recordedLive);
  const active = all.filter((r) => !r.stale);
  const stale = all.filter((r) => r.stale);
  const now = opts.nowMs ?? Date.now();
  const isFederated = (r: RosterRow) => r.federated === true;
  // Tier-1 enrichment stays ACTIVE-only (cost, P-003); wakeability is fetched for
  // BOTH active AND stale locals — a stale (heartbeat>10min) row with a live await
  // is `parked`, not gone, and that is exactly the dispatch target P-001 surfaces.
  const localActiveIds = active.filter((r) => !isFederated(r)).map((r) => r.ownerId);
  const localAllIds = all.filter((r) => !isFederated(r)).map((r) => r.ownerId);
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
  const withWakeability = (r: RosterRow): RosterRow => {
    const w = wakeability.get(r.ownerId);
    if (!w) return r;
    // A session-log-derived row (P-001) is AUTHORITATIVELY live (its adv_sessions
    // ended_at IS NULL) but, until it self-registers a coord await, has no
    // inbox-wake → it is `recorded` (alive, not inbox-wake-dispatchable), NOT
    // `ended` (which means dead/relaunch). A recorded session that HAS begun
    // registering (a live await exists → wakeable) derives normally below.
    const recordedLiveOnly = r.source === RECORDED_SESSION_SOURCE && !w.wakeable;
    return {
      ...r,
      wakeable: w.wakeable,
      sessionState: recordedLiveOnly
        ? 'recorded'
        : deriveSessionState({ stale: !!r.stale, wakeable: w.wakeable, liveTurn: w.liveTurn }),
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
    .map(withFleet);
  const staleEnriched = stale.map((r) =>
    withFleet(withViewerAttached(withOnDesktop(withWakeability(r as RosterRow)))),
  );
  let activeRows = activeEnriched.map(toStableRosterRow);

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
  let wakeable = 0;
  let onDesktop = 0;
  let viewerAttached = 0;
  for (const r of [...activeEnriched, ...staleEnriched]) {
    if (r.wakeable === true) wakeable += 1;
    if (r.onDesktop === true) onDesktop += 1;
    if (r.viewerAttached === true) viewerAttached += 1;
    const state = r.sessionState;
    if (state === 'live' || state === 'parked' || state === 'ended' || state === 'recorded') {
      byState[state] += 1;
    }
  }

  return {
    as_of: new Date(now).toISOString(),
    scope,
    ...(hiveId ? { hive: hiveId } : {}),
    ...(scopeNote ? { scope_note: scopeNote } : {}),
    summary: {
      active: active.length,
      stale: stale.length,
      federated: federated.length,
      wakeable,
      onDesktop,
      viewerAttached,
      byState,
    },
    active: activeRows,
    ...(opts.includeStale ? { stale: staleEnriched.map(toStableRosterRow) } : {}),
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
 * tailing deltas. Capped at REBOOTSTRAP_MAX_ROWS; overflow points at
 * coord:presence. Pure (snapshot in → string out) so it is unit-testable.
 */
export function renderPresenceRebootstrapBlock(snap: PresenceSnapshot): string {
  const shown = snap.active.slice(0, REBOOTSTRAP_MAX_ROWS);
  const overflow = snap.active.length - shown.length;
  const header =
    `[presence ⟲ ${snap.summary.active}] roster re-read after context compaction — ` +
    `baseline restored, tail [coord+N] deltas from here (as_of ${snap.as_of})`;
  const lines = shown.map((r) => {
    const label = String(r.ownerLabel ?? r.ownerId ?? '?');
    const role = r.agentRole ? `[${String(r.agentRole)}]` : '[—]';
    const intent = r.intent ? String(r.intent) : '';
    const plan = r.currentPlanSlug ? ` (${String(r.currentPlanSlug)})` : '';
    return `${label} ${role} ${intent}${plan}`.trimEnd();
  });
  if (overflow > 0) lines.push(`…+${overflow} more (coord:presence for the full roster)`);
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
