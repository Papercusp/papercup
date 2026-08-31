/**
 * Display-name store — reads/writes harness_shared.agent_display_names, the
 * owner-keyed MANUAL name a human (or an agent naming itself) gave a session.
 *
 * Plan hud-session-display-names-2026-08-31, ruled by D-003. The grain is
 * load-bearing and was corrected by measurement: a name belongs to the AGENT
 * (ownerId), not to one `adv_sessions` launch row, because 77 owners hold 2–4
 * of those rows and the two readers (coord:glance for the OS title, adv-roster
 * for the HUD card) pick rows differently — so a per-row name could show one
 * thing in a tab bar and another on the card. Reading by ownerId makes that
 * divergence unrepresentable.
 *
 * Encoding contract, mirrored by the migration's CHECK: "no manual name" is the
 * ABSENCE of a row, never a blank or null `display_name`. Clearing a name
 * DELETEs. That keeps exactly one encoding of the unnamed state, so the
 * resolver (`sessionDisplayName` in agent-tools/coordination/status-display.ts)
 * never has to distinguish "" from null from missing.
 *
 * These reads sit on the statusline hot path (every glance tick) and on the HUD
 * roster, so the batch form exists to keep the roster at ONE query for its whole
 * owner set rather than one per card (R10). Callers are expected to wrap them
 * fail-open: a name is decoration, and a read hiccup must degrade to the
 * objective fallback, never to a thrown card or a blank title (R9).
 *
 * Injectable `sql` seam, like the sibling mode store: the logic stays unit
 * testable without a live Postgres.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

export interface AgentDisplayNameRow {
  ownerId: string;
  /** Always trimmed and non-empty — the table's CHECK makes anything else unrepresentable. */
  displayName: string;
  /** A coord ownerId when an agent named itself, or 'owner' when a human did. Null on legacy rows. */
  setBy: string | null;
  setAt: string | null;
}

function toRow(r: Record<string, unknown>): AgentDisplayNameRow {
  return {
    ownerId: String(r.owner_id ?? ''),
    displayName: String(r.display_name ?? ''),
    setBy: r.set_by == null ? null : String(r.set_by),
    setAt: r.set_at == null ? null : new Date(r.set_at as string).toISOString(),
  };
}

/**
 * The manual name for ONE owner, or null when the owner has none.
 *
 * Returns the bare string because that is what the resolver consumes; use
 * `getAgentDisplayNameRow` when you also need who set it and when.
 */
export async function getAgentDisplayName(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<string | null> {
  return (await getAgentDisplayNameRow(workspaceId, ownerId, sql))?.displayName ?? null;
}

/** The full row for ONE owner (name + provenance), or null when unnamed. */
export async function getAgentDisplayNameRow(
  workspaceId: string,
  ownerId: string,
  sql?: Sql,
): Promise<AgentDisplayNameRow | null> {
  if (!workspaceId || !ownerId) return null;
  const rows = await pg(sql)<Array<Record<string, unknown>>>`
    SELECT owner_id, display_name, set_by, set_at
      FROM harness_shared.agent_display_names
     WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
     LIMIT 1`;
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Names for a WHOLE owner set in ONE query — the roster's read (R10).
 *
 * Owners with no manual name are simply absent from the map, matching the
 * table's "absence means unnamed" encoding, so a caller can hand
 * `map.get(ownerId)` straight to the resolver's `manualName`.
 */
export async function getAgentDisplayNames(
  workspaceId: string,
  ownerIds: readonly string[],
  sql?: Sql,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!workspaceId) return out;
  const ids = [...new Set(ownerIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return out;
  const db = pg(sql);
  const rows = await db<Array<Record<string, unknown>>>`
    SELECT owner_id, display_name, set_by, set_at
      FROM harness_shared.agent_display_names
     WHERE workspace_id = ${workspaceId} AND owner_id IN ${db(ids)}`;
  for (const r of rows) {
    const row = toRow(r);
    if (row.ownerId && row.displayName) out.set(row.ownerId, row.displayName);
  }
  return out;
}
