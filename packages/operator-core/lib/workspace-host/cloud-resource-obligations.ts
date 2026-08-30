/**
 * cloud-resource-obligations.ts — the durable per-resource teardown obligation ledger
 * (closes EI-21915296593490861).
 *
 * WHY THIS EXISTS
 * ----------------
 * P-046 agents repeatedly create real, metered GCP infra (custom networks, subnets,
 * Cloud Routers, Cloud NATs) because the project default network has no NAT and a
 * clean-room/Packer guest cannot reach the internet without one. Until now the
 * teardown obligation was recorded ONLY as prose in a work-item checkpoint ("Tear down
 * after the release run", "TEARDOWN OWED — this is a standing GCP cost"). Nothing
 * enforced or detected it, and prose does not survive the creating agent's death:
 * WI-40474 measured three successive holders dying/stalling in sequence while the
 * obligation sat undischarged in checkpoint text across every handoff (~18h and
 * counting at filing time).
 *
 * This module makes the obligation a ROW in harness_shared.cloud_resource_obligations
 * (migration 1040), not a paragraph — written at (or shortly after) the moment the
 * resource is created, keyed to the resource identity itself. Detection then no longer
 * depends on any one agent's session surviving to hand off the prose: `recordEscalation`
 * and `selectCloudResourceObligationsToEscalate` are consumed by a scheduled DBOS
 * workflow (`cloudResourceObligationSweep` in periodic-workflows.ts) that runs on its
 * own cadence, independent of every agent's liveness.
 *
 * SCOPE: this module tracks and ESCALATES stale obligations. It does not itself call any
 * cloud provider API to enumerate or delete resources — the filing agent (and this
 * module's own author) hit the same gap: `compute.routers.list` is denied to the only
 * working credential available in-session. Actual teardown remains a human/infra-owner
 * action taken against the escalation work-item this sweep files. What this closes is
 * the detector gap the issue names as "the second bug": a network-tier resource created
 * outside the typed `gcp-safety.ts` provisioning/destroy workflow (see that file's
 * `censusGcpWorkspaceHostResources`, which already covers router/nat/network/subnetwork
 * kinds but is only ever invoked as a step WITHIN a create/destroy call — never on an
 * owner-independent schedule) previously had no durable record and no sweep at all.
 *
 * Server-only.
 */
import type postgres from 'postgres';

export const CLOUD_RESOURCE_OBLIGATION_VERSION = 'cloud-resource-obligations-v1';

/** Default grace before a fresh obligation becomes escalation-eligible: one working day. */
export const CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS = 21_600_000; // 6h, matches migration default

/** Minimum time between successive escalations of the SAME obligation (avoid re-filing every tick). */
export const CLOUD_RESOURCE_OBLIGATION_DEFAULT_ESCALATION_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

export interface CloudResourceObligationRow {
  id: number;
  workspaceId: string;
  provider: string;
  resourceKind: string;
  resourceId: string;
  projectId: string;
  purpose: string;
  createdByOwnerId: string;
  sourceWorkItemId: string;
  createdAtMs: number;
  graceMs: number;
  teardownOwed: boolean;
  closedAtMs: number | null;
  closedReason: string;
  lastEscalatedAtMs: number | null;
  escalationWorkItemId: string;
  updatedAtMs: number;
}

export interface CloudResourceObligationRecordInput {
  workspaceId: string;
  /** Only 'gcp' is accepted today; the column CHECK constraint enforces this too. */
  provider: 'gcp';
  resourceKind: string;
  resourceId: string;
  projectId?: string;
  purpose?: string;
  createdByOwnerId?: string;
  sourceWorkItemId?: string;
  graceMs?: number;
}

/** Row → typed shape. postgres.js returns bigint/timestamptz columns as string | Date; normalize both. */
function toRow(raw: Record<string, unknown>): CloudResourceObligationRow {
  const toMs = (value: unknown): number => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') return Date.parse(value);
    throw new Error(`cloud resource obligation: unexpected timestamp shape ${typeof value}`);
  };
  const toMsOrNull = (value: unknown): number | null => (value == null ? null : toMs(value));
  return {
    id: Number(raw.id),
    workspaceId: String(raw.workspace_id),
    provider: String(raw.provider),
    resourceKind: String(raw.resource_kind),
    resourceId: String(raw.resource_id),
    projectId: String(raw.project_id ?? ''),
    purpose: String(raw.purpose ?? ''),
    createdByOwnerId: String(raw.created_by_owner_id ?? ''),
    sourceWorkItemId: String(raw.source_work_item_id ?? ''),
    createdAtMs: toMs(raw.created_at),
    graceMs: Number(raw.grace_ms),
    teardownOwed: Boolean(raw.teardown_owed),
    closedAtMs: toMsOrNull(raw.closed_at),
    closedReason: String(raw.closed_reason ?? ''),
    lastEscalatedAtMs: toMsOrNull(raw.last_escalated_at),
    escalationWorkItemId: String(raw.escalation_work_item_id ?? ''),
    updatedAtMs: toMs(raw.updated_at),
  };
}

/**
 * Write the obligation at (or immediately after) resource-creation time. Idempotent on
 * (workspaceId, provider, resourceKind, resourceId): a re-call for a resource already
 * tracked is a no-op (`created: false`) rather than a duplicate or an error, so a
 * retried creation step never double-files.
 */
export async function recordCloudResourceObligation(
  sql: postgres.Sql,
  input: CloudResourceObligationRecordInput,
): Promise<{ id: number; created: boolean }> {
  requireNonEmpty(input.workspaceId, 'workspaceId');
  requireNonEmpty(input.resourceKind, 'resourceKind');
  requireNonEmpty(input.resourceId, 'resourceId');
  const graceMs = input.graceMs ?? CLOUD_RESOURCE_OBLIGATION_DEFAULT_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error('graceMs must be a non-negative safe integer');
  const rows = await sql<{ id: number; inserted: boolean }[]>`
    INSERT INTO harness_shared.cloud_resource_obligations
      (workspace_id, provider, resource_kind, resource_id, project_id, purpose,
       created_by_owner_id, source_work_item_id, grace_ms)
    VALUES
      (${input.workspaceId}, ${input.provider}, ${input.resourceKind}, ${input.resourceId},
       ${input.projectId ?? ''}, ${input.purpose ?? ''}, ${input.createdByOwnerId ?? ''},
       ${input.sourceWorkItemId ?? ''}, ${graceMs})
    ON CONFLICT (workspace_id, provider, resource_kind, resource_id) DO NOTHING
    RETURNING id, true AS inserted
  `;
  if (rows.length > 0) return { id: Number(rows[0]!.id), created: true };
  const existing = await sql<{ id: number }[]>`
    SELECT id FROM harness_shared.cloud_resource_obligations
     WHERE workspace_id = ${input.workspaceId}
       AND provider = ${input.provider}
       AND resource_kind = ${input.resourceKind}
       AND resource_id = ${input.resourceId}
  `;
  if (existing.length === 0) throw new Error('cloud resource obligation upsert raced past both the insert and the read');
  return { id: Number(existing[0]!.id), created: false };
}

/**
 * Close the obligation — the resource was actually torn down (or confirmed to have
 * never existed). Idempotent: closing an already-closed row is a no-op.
 */
export async function closeCloudResourceObligation(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    provider: string;
    resourceKind: string;
    resourceId: string;
    reason: string;
  },
): Promise<{ closed: boolean }> {
  requireNonEmpty(input.reason, 'reason');
  const rows = await sql<{ id: number }[]>`
    UPDATE harness_shared.cloud_resource_obligations
       SET closed_at = now(), closed_reason = ${input.reason}, teardown_owed = false, updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND provider = ${input.provider}
       AND resource_kind = ${input.resourceKind}
       AND resource_id = ${input.resourceId}
       AND closed_at IS NULL
     RETURNING id
  `;
  return { closed: rows.length > 0 };
}

/** Every still-open, teardown-owed obligation — the sweep's whole input. */
export async function listOpenCloudResourceObligations(
  sql: postgres.Sql,
  opts: { workspaceId?: string } = {},
): Promise<CloudResourceObligationRow[]> {
  const rows = opts.workspaceId
    ? await sql<Record<string, unknown>[]>`
        SELECT * FROM harness_shared.cloud_resource_obligations
         WHERE closed_at IS NULL AND teardown_owed AND workspace_id = ${opts.workspaceId}
         ORDER BY created_at ASC
      `
    : await sql<Record<string, unknown>[]>`
        SELECT * FROM harness_shared.cloud_resource_obligations
         WHERE closed_at IS NULL AND teardown_owed
         ORDER BY created_at ASC
      `;
  return rows.map(toRow);
}

/** Stamp that an escalation was just filed/refreshed for this obligation. */
export async function markCloudResourceObligationEscalated(
  sql: postgres.Sql,
  id: number,
  workItemId: string,
): Promise<void> {
  requireNonEmpty(workItemId, 'workItemId');
  await sql`
    UPDATE harness_shared.cloud_resource_obligations
       SET last_escalated_at = now(), escalation_work_item_id = ${workItemId}, updated_at = now()
     WHERE id = ${id}
  `;
}

export interface CloudResourceObligationEscalationCandidate {
  id: number;
  workspaceId: string;
  provider: string;
  resourceKind: string;
  resourceId: string;
  projectId: string;
  purpose: string;
  sourceWorkItemId: string;
  createdAtMs: number;
  ageMs: number;
  /** true when a prior escalation already exists (this is a re-nudge, not the first). */
  hadPriorEscalation: boolean;
  priorEscalationWorkItemId: string;
}

/**
 * PURE decision logic — no I/O, unit-testable without a database. Given the open rows
 * a sweep tick just read, decide which are escalation-eligible right now:
 *   - past their own grace period (createdAtMs + graceMs <= evaluatedAtMs), AND
 *   - never escalated before, OR the last escalation is older than escalateCooldownMs
 *     (so a live escalation work-item is re-nudged rather than silently going stale,
 *     but not re-filed every single tick).
 * Ordered oldest-first — the longest-standing obligation is the most urgent one.
 */
export function selectCloudResourceObligationsToEscalate(
  rows: readonly CloudResourceObligationRow[],
  evaluatedAtMs: number,
  escalateCooldownMs: number = CLOUD_RESOURCE_OBLIGATION_DEFAULT_ESCALATION_COOLDOWN_MS,
): CloudResourceObligationEscalationCandidate[] {
  if (!Number.isFinite(evaluatedAtMs)) throw new Error('evaluatedAtMs must be finite');
  if (!Number.isSafeInteger(escalateCooldownMs) || escalateCooldownMs < 0) {
    throw new Error('escalateCooldownMs must be a non-negative safe integer');
  }
  const out: CloudResourceObligationEscalationCandidate[] = [];
  for (const row of rows) {
    if (row.closedAtMs !== null || !row.teardownOwed) continue; // caller should already filter; re-assert
    const pastGrace = row.createdAtMs + row.graceMs <= evaluatedAtMs;
    if (!pastGrace) continue;
    const dueForNudge = row.lastEscalatedAtMs === null || evaluatedAtMs - row.lastEscalatedAtMs >= escalateCooldownMs;
    if (!dueForNudge) continue;
    out.push({
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      projectId: row.projectId,
      purpose: row.purpose,
      sourceWorkItemId: row.sourceWorkItemId,
      createdAtMs: row.createdAtMs,
      ageMs: evaluatedAtMs - row.createdAtMs,
      hadPriorEscalation: row.lastEscalatedAtMs !== null,
      priorEscalationWorkItemId: row.escalationWorkItemId,
    });
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs);
}
