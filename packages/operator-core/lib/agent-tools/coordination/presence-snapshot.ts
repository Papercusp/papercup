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

import { listPresence, sweepStalePresence } from './presence';
import { listFederatedPresence } from './federated-presence';
import { fetchPresenceTier1, mergeTier1, type PresenceTier1Joins } from './presence-tier1';
import { toStableRosterRow } from './presence-payload';

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
  summary: { active: number; stale: number; federated: number };
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
  const wsId = scope === 'all' ? null : callerWs;
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
  opts: { includeStale?: boolean; nowMs?: number } = {},
): Promise<PresenceSnapshot> {
  const { wsId, hiveId, scope, scopeNote } = resolved;
  const [records, federated] = await Promise.all([
    listPresence({ workspaceId: wsId, hiveSlug: hiveId }),
    listFederatedPresence({ workspaceId: wsId, hiveSlug: hiveId }),
    sweepStalePresence(PRESENCE_GC_MS).catch(() => 0),
  ]);
  const all = [...records, ...federated];
  const active = all.filter((r) => !r.stale);
  const stale = all.filter((r) => r.stale);
  const now = opts.nowMs ?? Date.now();
  let joins = new Map<string, PresenceTier1Joins>();
  try {
    const localIds = active
      .filter((r) => !(r as { federated?: boolean }).federated)
      .map((r) => r.ownerId);
    joins = await fetchPresenceTier1(localIds);
  } catch {
    /* best-effort enrichment — presence must list even if a join fails */
  }
  const activeEnriched = mergeTier1(active, joins, now);
  return {
    as_of: new Date(now).toISOString(),
    scope,
    ...(hiveId ? { hive: hiveId } : {}),
    ...(scopeNote ? { scope_note: scopeNote } : {}),
    summary: { active: active.length, stale: stale.length, federated: federated.length },
    active: activeEnriched.map(toStableRosterRow),
    ...(opts.includeStale ? { stale: stale.map(toStableRosterRow) } : {}),
  };
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
