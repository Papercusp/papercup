/**
 * Mode store — reads/writes harness_shared.agent_modes (+ the append-only
 * agent_mode_changes audit) with the axis semantics enforced at the write
 * (modes-and-intake-ux-2026-07-05 P-006, D-003, D-006).
 *
 * Semantics enforced HERE (not in the tool layer), so every caller gets them:
 *   - AUTO-SWITCH: setting a mode replaces the same-axis incumbent in one
 *     upsert (PK (workspace_id, owner_id, axis_key)); the displaced mode is
 *     returned as `switchedFrom` and audited as its own transition.
 *   - OWNER-STICKY (D-003): a row with owner_directed=true can only be
 *     changed by its own agent (self) or an owner-directed write; a peer's
 *     attempt returns { stickyConflict: true } and writes NOTHING — the tool
 *     layer downgrades it to a request message.
 *   - AUDIT: every applied transition (set / clear / auto-switch displacement)
 *     appends an agent_mode_changes row.
 *
 * Injectable `sql` seam for unit tests (same discipline as the rest of the
 * coordination layer: pure logic testable without PG).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { modeById, axisKeyFor, type ModeDef } from './registry';

export interface ModeRow {
  workspaceId: string;
  ownerId: string;
  axisKey: string;
  mode: string;
  reason: string;
  setBy: string;
  ownerDirected: boolean;
  setAt: string;
}

export interface SetModeOpts {
  workspaceId: string;
  /** The agent whose mode changes. */
  ownerId: string;
  modeId: string;
  /** false ⇒ exit the mode (clear its row if currently set). */
  enabled: boolean;
  reason: string;
  /** The caller (self-set when === ownerId). */
  setBy: string;
  /** The human owner explicitly instructed this — arms the sticky flag. */
  ownerDirected?: boolean;
  sql?: Sql;
}

export interface SetModeResult {
  ok: boolean;
  /** The write was refused because the incumbent is owner-directed and the caller is a peer. */
  stickyConflict?: boolean;
  /** The same-axis mode that was displaced by this set (auto-switch, D-006). */
  switchedFrom?: string | null;
  /** True when the write changed nothing (already in / already out). */
  noop?: boolean;
  mode?: ModeDef;
  error?: string;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function toRow(r: Record<string, unknown>): ModeRow {
  return {
    workspaceId: String(r.workspace_id),
    ownerId: String(r.owner_id),
    axisKey: String(r.axis_key),
    mode: String(r.mode),
    reason: String(r.reason ?? ''),
    setBy: String(r.set_by ?? ''),
    ownerDirected: Boolean(r.owner_directed),
    setAt: r.set_at instanceof Date ? r.set_at.toISOString() : String(r.set_at),
  };
}

/** Current modes for one agent. */
export async function getModes(workspaceId: string, ownerId: string, sql?: Sql): Promise<ModeRow[]> {
  const rows = await pg(sql)`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}
    ORDER BY axis_key`;
  return rows.map(toRow);
}

/** Current modes for many agents in one round-trip — the presence/orient fan-in. */
export async function getModesForOwners(
  workspaceId: string,
  ownerIds: readonly string[],
  sql?: Sql,
): Promise<Map<string, ModeRow[]>> {
  const out = new Map<string, ModeRow[]>();
  if (!ownerIds.length) return out;
  const rows = await pg(sql)`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${workspaceId} AND owner_id IN ${pg(sql)(ownerIds as string[])}
    ORDER BY axis_key`;
  for (const r of rows) {
    const row = toRow(r);
    const list = out.get(row.ownerId) ?? [];
    list.push(row);
    out.set(row.ownerId, list);
  }
  return out;
}

async function audit(
  sql: Sql,
  o: { workspaceId: string; ownerId: string; axisKey: string; oldMode: string | null; newMode: string | null; reason: string; setBy: string; ownerDirected: boolean },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_mode_changes
      (workspace_id, owner_id, axis_key, old_mode, new_mode, reason, set_by, owner_directed)
    VALUES (${o.workspaceId}, ${o.ownerId}, ${o.axisKey}, ${o.oldMode}, ${o.newMode},
            ${o.reason}, ${o.setBy}, ${o.ownerDirected})`;
}

/**
 * Apply one mode transition with the axis + sticky semantics. See module doc.
 * All-or-nothing per call; never throws for semantic refusals (returns
 * stickyConflict / error), only for infrastructure failures.
 */
export async function setMode(opts: SetModeOpts): Promise<SetModeResult> {
  const def = modeById(opts.modeId);
  if (!def) return { ok: false, error: `unknown mode '${opts.modeId}'` };
  const sql = pg(opts.sql);
  const axisKey = axisKeyFor(def);
  const isSelf = opts.setBy === opts.ownerId;
  const ownerDirected = Boolean(opts.ownerDirected) && isSelf; // peers can never arm sticky for others

  const existing = await sql`
    SELECT * FROM harness_shared.agent_modes
    WHERE workspace_id = ${opts.workspaceId} AND owner_id = ${opts.ownerId} AND axis_key = ${axisKey}`;
  const incumbent = existing.length ? toRow(existing[0] as Record<string, unknown>) : null;

  // OWNER-STICKY (D-003): a peer cannot change an owner-directed incumbent
  // (neither replace it nor clear it). Self + owner-directed writes pass.
  if (incumbent?.ownerDirected && !isSelf && !opts.ownerDirected) {
    return { ok: false, stickyConflict: true, mode: def, switchedFrom: incumbent.mode };
  }

  if (!opts.enabled) {
    if (!incumbent || incumbent.mode !== def.id) return { ok: true, noop: true, mode: def };
    await sql`
      DELETE FROM harness_shared.agent_modes
      WHERE workspace_id = ${opts.workspaceId} AND owner_id = ${opts.ownerId} AND axis_key = ${axisKey}`;
    await audit(sql, {
      workspaceId: opts.workspaceId, ownerId: opts.ownerId, axisKey,
      oldMode: incumbent.mode, newMode: null, reason: opts.reason, setBy: opts.setBy, ownerDirected,
    });
    return { ok: true, mode: def, switchedFrom: null };
  }

  if (incumbent?.mode === def.id) {
    // Already in this mode — refresh reason/sticky only if they changed.
    if (incumbent.ownerDirected === ownerDirected && incumbent.reason === opts.reason) {
      return { ok: true, noop: true, mode: def };
    }
  }

  await sql`
    INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at)
    VALUES (${opts.workspaceId}, ${opts.ownerId}, ${axisKey}, ${def.id}, ${opts.reason},
            ${opts.setBy}, ${ownerDirected}, now())
    ON CONFLICT (workspace_id, owner_id, axis_key) DO UPDATE SET
      mode = EXCLUDED.mode, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by,
      owner_directed = EXCLUDED.owner_directed, set_at = EXCLUDED.set_at`;
  await audit(sql, {
    workspaceId: opts.workspaceId, ownerId: opts.ownerId, axisKey,
    oldMode: incumbent?.mode ?? null, newMode: def.id, reason: opts.reason, setBy: opts.setBy, ownerDirected,
  });
  const switchedFrom = incumbent && incumbent.mode !== def.id ? incumbent.mode : null;
  return { ok: true, mode: def, switchedFrom };
}
