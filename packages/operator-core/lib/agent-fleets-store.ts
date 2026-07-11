/**
 * agent-fleets-store — PG access to harness_shared.agent_fleets, the durable
 * named-fleet registry (named-su-agent-fleets-2026-06-29, D-001; migration 406).
 *
 * A fleet = a persistent named group of su agents. THIS ROW is the durable
 * identity: it survives all-members-killed, so the fleet stays selectable (D-003).
 * Live membership is a SOFT label on shared_presence (fleet_slug/fleet_role), NOT
 * here. `leaderOwnerId` is the current leader — the agent who created the fleet or
 * last took it on a handoff ("handoff agent becomes leader", D-002).
 *
 * Workspace-scoped: every query carries an explicit `WHERE workspace_id = $1`
 * (RLS is the backstop, mirroring hive-store.ts). Every fn takes an optional `sql`
 * client so integration tests can pass a per-file test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  allocateNextSchemeName,
  schemeByName,
  schemeForSlug,
  type ColorScheme,
} from './console-color-schemes';

/** Typed fleet control state (coord-authority-hardening-2026-07-11 P-009 / H4). */
export type FleetControlState = 'active' | 'winding-down';

/** A named-fleet registry row. */
export interface AgentFleetRecord {
  workspaceId: string;
  fleetSlug: string;
  title: string | null;
  description: string | null;
  /** Coord owner-id that created the fleet. */
  owner: string | null;
  /** The CURRENT leader's coord owner-id (D-002). Null when unset (e.g. the
   *  fleet persists but no agent currently leads it). */
  leaderOwnerId: string | null;
  /** The fleet's permanently-bound color-scheme NAME (console-color-schemes).
   *  Null on legacy rows created before the binding existed — resolveFleetScheme
   *  falls back to a deterministic slug hash for those. */
  colorScheme: string | null;
  /** P-009 (H4): the fleet's typed control state — 'active' | 'winding-down'
   *  (mig 575; fleet:pause aliases wind-down). PLATFORM state on the durable
   *  row, so late joiners read it at orient instead of missing a broadcast. */
  controlState: FleetControlState;
  /** Invoker-stated reason for the current control state (advisory). */
  controlReason: string | null;
  /** Coord owner-id that set the current control state (audit). */
  controlBy: string | null;
  /** Epoch ms when the current control state was set. */
  controlAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFleetInput {
  workspaceId: string;
  fleetSlug: string;
  title?: string | null;
  description?: string | null;
  owner?: string | null;
  leaderOwnerId?: string | null;
  /** Force a specific scheme name; omit to auto-allocate the next unused one. */
  colorScheme?: string | null;
}

interface FleetRow {
  workspace_id: string;
  fleet_slug: string;
  title: string | null;
  description: string | null;
  owner: string | null;
  leader_owner_id: string | null;
  color_scheme: string | null;
  control_state: string | null;
  control_reason: string | null;
  control_by: string | null;
  control_at: string | number | null;
  created_at: string | number;
  updated_at: string | number;
}

function rowToRecord(r: FleetRow): AgentFleetRecord {
  return {
    workspaceId: r.workspace_id,
    fleetSlug: r.fleet_slug,
    title: r.title,
    description: r.description,
    owner: r.owner,
    leaderOwnerId: r.leader_owner_id,
    colorScheme: r.color_scheme,
    // Defensive: only the one non-default state is honored; anything else
    // (legacy null, a hand-forged value) reads back 'active'.
    controlState: r.control_state === 'winding-down' ? 'winding-down' : 'active',
    controlReason: r.control_reason ?? null,
    controlBy: r.control_by ?? null,
    controlAt: r.control_at == null ? null : Number(r.control_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * WI-2006 (P-101 publish leg): every fleet lifecycle write refreshes the
 * owner-signed directory card (p2p/fleet-directory-publish) so the fleet is
 * hive-browsable and its scope roster widens cross-node. Lazy dynamic import +
 * fire-and-forget: the store stays PG-pure, a publish fault never fails the
 * fleet write, and unit tests (which pass a per-file `sql` schema) never touch
 * identity/keychain/hive resolution.
 */
function refreshDirectoryCard(
  workspaceId: string,
  fleetSlug: string,
  opts?: { archived?: boolean; sql?: Sql },
): void {
  if (opts?.sql) return; // test-schema override ⇒ never publish for real
  void import('./p2p/fleet-directory-publish')
    .then((m) => m.publishFleetDirectoryRecordBestEffort({ workspaceId, fleetSlug, archived: opts?.archived }))
    .catch(() => {});
}

const COLS = `workspace_id, fleet_slug, title, description, owner, leader_owner_id, color_scheme, control_state, control_reason, control_by, control_at, created_at, updated_at`;

/**
 * Derive a stable fleet_slug from a user-entered fleet NAME. The original name
 * is kept in `title`; this is the kebab-case handle (the durable id + env var
 * value + presence label). Always returns a non-empty slug.
 */
export function fleetSlugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'fleet';
}

/** One fleet by its slug. */
export async function getFleet(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.agent_fleets WHERE workspace_id = $1 AND fleet_slug = $2 LIMIT 1`,
    [workspaceId, fleetSlug],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Every persisted fleet in the workspace, newest first. (These persist even
 *  with zero live members — D-003 — so this is the psu "pick existing" list.) */
export async function listFleets(workspaceId: string, sql?: Sql): Promise<AgentFleetRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.agent_fleets WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  )) as unknown as FleetRow[];
  return rows.map(rowToRecord);
}

/**
 * Every fleet this agent currently LEADS (agent_fleets.leader_owner_id), newest
 * first. Unlike presence membership — a single soft label that collapses to the
 * latest fleet joined — leadership is a per-fleet fact, so an agent that took
 * leadership of several fleets shows up here for ALL of them. This is the Scope-A
 * source for the multi-fleet terminal identity (WI-1963): "which fleets is this
 * agent in" as a SET, with no schema change.
 */
export async function listFleetsLedBy(
  workspaceId: string,
  leaderOwnerId: string,
  sql?: Sql,
): Promise<AgentFleetRecord[]> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${COLS} FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND leader_owner_id = $2
      ORDER BY created_at DESC`,
    [workspaceId, leaderOwnerId],
  )) as unknown as FleetRow[];
  return rows.map(rowToRecord);
}

/**
 * Get-or-create a fleet. Idempotent: an existing (workspace, fleet_slug) row is
 * returned UNCHANGED; title/description/owner/leader apply only on first insert
 * (edit later via updateFleetMeta / setFleetLeader). `created` reflects insert.
 */
export async function createFleetIfAbsent(
  input: CreateFleetInput,
  sql?: Sql,
): Promise<{ record: AgentFleetRecord; created: boolean }> {
  const s = pg(sql);
  const now = Date.now();
  // Bind a color scheme at birth — per-fleet permanent visual identity. Caller
  // may force one; else allocate the next UNUSED catalog scheme so distinct
  // fleets look distinct. A wasted allocation on an idempotent no-op insert is
  // harmless: the existing row (ON CONFLICT DO NOTHING) keeps its first scheme.
  const colorScheme =
    input.colorScheme ?? (await allocateSchemeForWorkspace(input.workspaceId, sql));
  const inserted = (await s.unsafe(
    `INSERT INTO harness_shared.agent_fleets (${COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, NULL, NULL, $8, $8)
     ON CONFLICT (workspace_id, fleet_slug) DO NOTHING
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.fleetSlug,
      input.title ?? null,
      input.description ?? null,
      input.owner ?? null,
      input.leaderOwnerId ?? null,
      colorScheme,
      now,
    ],
  )) as unknown as FleetRow[];
  // Create AND ensure both refresh the card: the ensure path self-heals fleets
  // that predate the publish leg, and the module's no-churn gate keeps an
  // unchanged card from re-federating on every launch.
  refreshDirectoryCard(input.workspaceId, input.fleetSlug, { sql });
  if (inserted[0]) return { record: rowToRecord(inserted[0]), created: true };
  const existing = await getFleet(input.workspaceId, input.fleetSlug, sql);
  if (!existing) {
    throw new Error(
      `createFleetIfAbsent: conflict on (${input.workspaceId}, ${input.fleetSlug}) but no row found`,
    );
  }
  return { record: existing, created: false };
}

/**
 * Set the current leader (D-002: the handoff agent becomes leader). Pass null to
 * clear. Idempotent; bumps updated_at. Returns null if the fleet doesn't exist.
 */
export async function setFleetLeader(
  workspaceId: string,
  fleetSlug: string,
  leaderOwnerId: string | null,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET leader_owner_id = $3, updated_at = $4
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, leaderOwnerId, Date.now()],
  )) as unknown as FleetRow[];
  if (rows[0]) refreshDirectoryCard(workspaceId, fleetSlug, { sql });
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Set the fleet's typed CONTROL STATE (P-009 / H4): 'winding-down' | 'active'.
 * Records who flipped it, why, and when — the registry row is the durable
 * source late joiners read at orient. Idempotent re-sets refresh reason/by/at
 * (the newest invocation's word stands). Returns null if the fleet doesn't exist.
 */
export async function setFleetControlState(
  workspaceId: string,
  fleetSlug: string,
  control: { state: FleetControlState; reason?: string | null; by?: string | null },
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const now = Date.now();
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET control_state = $3, control_reason = $4, control_by = $5, control_at = $6, updated_at = $6
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, control.state, control.reason ?? null, control.by ?? null, now],
  )) as unknown as FleetRow[];
  if (rows[0]) refreshDirectoryCard(workspaceId, fleetSlug, { sql });
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Edit a fleet's directory metadata (title/description). No leader side effects. */
export async function updateFleetMeta(
  workspaceId: string,
  fleetSlug: string,
  meta: { title?: string | null; description?: string | null },
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET title = COALESCE($3, title),
            description = COALESCE($4, description),
            updated_at = $5
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, meta.title ?? null, meta.description ?? null, Date.now()],
  )) as unknown as FleetRow[];
  if (rows[0]) refreshDirectoryCard(workspaceId, fleetSlug, { sql });
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Delete a fleet registry row. Idempotent. */
export async function deleteFleet(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `DELETE FROM harness_shared.agent_fleets WHERE workspace_id = $1 AND fleet_slug = $2 RETURNING fleet_slug`,
    [workspaceId, fleetSlug],
  )) as unknown as Array<{ fleet_slug: string }>;
  // Archive (not delete) the directory card — remote projections need the
  // signed archived record to stop resolving members/scopes (D-006/H10).
  if (rows.length > 0) refreshDirectoryCard(workspaceId, fleetSlug, { archived: true, sql });
  return rows.length > 0;
}

// ─── Color schemes (fleet-color-schemes-2026-06-30) ──────────────────

/**
 * Pick the next catalog scheme NAME for a new fleet in this workspace: the first
 * scheme not already bound to a fleet here (so distinct fleets stay distinct).
 * Best-effort distinctness — there's a benign race if two fleets are created at
 * once, and the catalog wraps once every scheme is in use.
 */
async function allocateSchemeForWorkspace(workspaceId: string, sql?: Sql): Promise<string> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT color_scheme FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND color_scheme IS NOT NULL`,
    [workspaceId],
  )) as unknown as Array<{ color_scheme: string }>;
  return allocateNextSchemeName(rows.map((r) => r.color_scheme));
}

/**
 * Resolve a fleet record to its concrete {@link ColorScheme}: the persisted
 * binding if present, else a deterministic slug-hash fallback for legacy rows.
 * Always returns a real catalog scheme.
 */
export function resolveFleetScheme(record: AgentFleetRecord): ColorScheme {
  return schemeByName(record.colorScheme) ?? schemeForSlug(record.fleetSlug);
}

/** The bound scheme for a fleet slug, or null if the fleet doesn't exist. */
export async function getFleetScheme(
  workspaceId: string,
  fleetSlug: string,
  sql?: Sql,
): Promise<ColorScheme | null> {
  const fleet = await getFleet(workspaceId, fleetSlug, sql);
  return fleet ? resolveFleetScheme(fleet) : null;
}

/**
 * Override a fleet's bound scheme (the otherwise-immutable binding) — the
 * `fleet:recolor` escape hatch. Returns null if the fleet doesn't exist.
 */
export async function setFleetScheme(
  workspaceId: string,
  fleetSlug: string,
  schemeName: string,
  sql?: Sql,
): Promise<AgentFleetRecord | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET color_scheme = $3, updated_at = $4
      WHERE workspace_id = $1 AND fleet_slug = $2
      RETURNING ${COLS}`,
    [workspaceId, fleetSlug, schemeName, Date.now()],
  )) as unknown as FleetRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Result of {@link claimFleetLaunchSlot}: the caller either WON the slot (proceed to
 *  spawn; `at` is the recorded claim time, needed to release on a fully-failed spawn)
 *  or lost to a fresh prior launch (suppress — `priorAt`/`priorCount` feed the notice). */
export type FleetLaunchSlot =
  | { won: true; at: number }
  | { won: false; priorAt: number; priorCount: number };

/**
 * Atomically claim a fleet's launch slot — the fleet:launch-on-plan idempotency guard.
 * ONE winner per (workspace, fleet) per `windowMs`, across ALL operator workers: the
 * check-and-set runs as a single SQL UPDATE, replacing the per-worker in-process Map
 * that let a weak model open 6 member waves in 40s on 2026-07-03 (each re-fire landed
 * on a different :3070 worker whose map was empty). Call AFTER createFleetIfAbsent —
 * the row must exist; a missing row fails OPEN (won, unrecorded) rather than wedging
 * the launch. `now` is injectable for deterministic window tests.
 */
export async function claimFleetLaunchSlot(opts: {
  workspaceId: string;
  fleetSlug: string;
  count: number;
  windowMs: number;
  now?: number;
  sql?: Sql;
}): Promise<FleetLaunchSlot> {
  const s = pg(opts.sql);
  const now = opts.now ?? Date.now();
  const won = (await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET last_launch_at = $3, last_launch_count = $4, updated_at = $3
      WHERE workspace_id = $1 AND fleet_slug = $2
        AND (last_launch_at IS NULL OR last_launch_at < $5)
      RETURNING fleet_slug`,
    [opts.workspaceId, opts.fleetSlug, now, opts.count, now - opts.windowMs],
  )) as unknown as Array<{ fleet_slug: string }>;
  if (won.length > 0) return { won: true, at: now };
  const prior = (await s.unsafe(
    `SELECT last_launch_at, last_launch_count FROM harness_shared.agent_fleets
      WHERE workspace_id = $1 AND fleet_slug = $2`,
    [opts.workspaceId, opts.fleetSlug],
  )) as unknown as Array<{ last_launch_at: string | number | null; last_launch_count: number | null }>;
  if (!prior[0] || prior[0].last_launch_at == null) return { won: true, at: now }; // fleet row vanished — fail open
  return { won: false, priorAt: Number(prior[0].last_launch_at), priorCount: Number(prior[0].last_launch_count ?? 0) };
}

/**
 * Release a launch slot claimed at `at` — ONLY when the launch it guarded opened
 * nothing (every spawn failed), so an immediate legitimate retry isn't suppressed
 * for the whole window. Guarded by `last_launch_at = at` so it never clears a
 * NEWER launch's claim.
 */
export async function releaseFleetLaunchSlot(opts: {
  workspaceId: string;
  fleetSlug: string;
  at: number;
  sql?: Sql;
}): Promise<void> {
  const s = pg(opts.sql);
  await s.unsafe(
    `UPDATE harness_shared.agent_fleets
        SET last_launch_at = NULL, last_launch_count = NULL
      WHERE workspace_id = $1 AND fleet_slug = $2 AND last_launch_at = $3`,
    [opts.workspaceId, opts.fleetSlug, opts.at],
  );
}
