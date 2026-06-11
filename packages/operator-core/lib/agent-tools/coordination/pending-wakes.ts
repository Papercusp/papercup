/**
 * pending-wakes.ts — the STAGED-wake queue for manual-mode agents
 * (hive-agent-tabs-psu-tui-2026-06-09 P-007 / D-005).
 *
 * When an agent's wake-mode is `manual` (wake-mode.ts), `wakeRecipients` STAGES
 * the wake here instead of firing it (the agent is NOT re-invoked). The owner
 * reviews them from the agent's pane and releases / edits / skips (P-008/P-009).
 * Table: harness_shared.pending_wakes (migration 204).
 */
import { getOrgPg } from '@papercusp/db-org';

export interface StageWakeInput {
  ownerId: string;
  summary?: string;
  /** Arbitrary wake payload (stored as jsonb). */
  payload?: unknown;
  source?: string;
  workspaceId?: string;
}

export interface PendingWake {
  id: number;
  ownerId: string;
  summary: string | null;
  payload: unknown;
  source: string | null;
  workspaceId: string | null;
  createdAt: string;
  /** How many identical fires coalesced into this row (EI-312; ≥1). */
  count: number;
  /** When the newest coalesced fire was staged (== createdAt until a re-fire). */
  lastSeenAt: string;
}

/**
 * Stage a wake for a manual-mode agent (the P-007 gate calls this instead of firing).
 *
 * EI-312: identical (owner, source, summary, workspace) re-fires COALESCE into the
 * existing staged row — bump `count` + `last_seen_at`, keep the newest payload as the
 * headline — instead of inserting review-spam duplicates. This mirrors the live pump's
 * per-subscriber coalescing (events/await/engine.ts) at the staging boundary, so a
 * wake storm against a paused agent reads as "watchdog ×11", not 11 queue rows.
 */
export async function stagePendingWake(input: StageWakeInput): Promise<void> {
  const { sql } = getOrgPg();
  const payloadJson = input.payload != null ? JSON.stringify(input.payload) : null;
  await sql`
    INSERT INTO harness_shared.pending_wakes (owner_id, summary, payload, source, workspace_id)
    VALUES (
      ${input.ownerId},
      ${input.summary ?? null},
      ${payloadJson}::jsonb,
      ${input.source ?? null},
      ${input.workspaceId ?? null}
    )
    ON CONFLICT (owner_id, coalesce(source, ''), coalesce(summary, ''), coalesce(workspace_id, ''))
    DO UPDATE SET
      count = pending_wakes.count + 1,
      last_seen_at = now(),
      payload = EXCLUDED.payload
  `;
}

/** An agent's staged wakes, oldest-first (the pane lists them in order). */
export async function listPendingWakes(ownerId: string): Promise<PendingWake[]> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT id, owner_id, summary, payload, source, workspace_id, created_at, count, last_seen_at
    FROM harness_shared.pending_wakes
    WHERE owner_id = ${ownerId}
    ORDER BY id ASC
  `;
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    ownerId: String(r.owner_id),
    summary: (r.summary as string | null) ?? null,
    payload: r.payload ?? null,
    source: (r.source as string | null) ?? null,
    workspaceId: (r.workspace_id as string | null) ?? null,
    createdAt: String(r.created_at),
    count: Number(r.count ?? 1),
    lastSeenAt: String(r.last_seen_at ?? r.created_at),
  }));
}

/** How many wakes are staged for an agent (the pane's pending-count badge). */
export async function countPendingWakes(ownerId: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql`SELECT count(*)::int AS n FROM harness_shared.pending_wakes WHERE owner_id = ${ownerId}`;
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/**
 * Staged-wake counts for ALL agents in one read, keyed by ownerId — for the
 * roster badge (P-008), where countPendingWakes per agent would be N
 * round-trips. Agents with nothing staged are absent (count 0).
 */
export async function countAllPendingWakes(): Promise<Map<string, number>> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT owner_id, count(*)::int AS n
    FROM harness_shared.pending_wakes
    GROUP BY owner_id
  `;
  const out = new Map<string, number>();
  for (const r of rows as unknown as Array<{ owner_id: string; n: number }>) {
    if (r.owner_id) out.set(r.owner_id, Number(r.n));
  }
  return out;
}

/** Drop one staged wake (after the owner releases / skips it). */
export async function releasePendingWake(id: number): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.pending_wakes WHERE id = ${id}`;
}

/** Drop ALL of an agent's staged wakes (release_all / skip_all). Returns rows dropped. */
export async function clearPendingWakes(ownerId: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql`
    DELETE FROM harness_shared.pending_wakes WHERE owner_id = ${ownerId} RETURNING id
  `;
  return (rows as unknown[]).length;
}
