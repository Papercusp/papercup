/**
 * Gym CONTROL PLANE (gym-ui-handoff backend, D-020) — the persistent, user-facing
 * state behind the generalized harness-gym UI, in the LIVE operator DB.
 *
 * D-020 refines D-018: the gym's heavy EXECUTION data (the real pipeline run,
 * transcripts, DBOS, per-task score vectors) stays in the dedicated ephemeral gym PG.
 * But the small control plane the UI reads + the user acts on persists here in
 * harness_shared, scoped by (workspace_id, harness_slug):
 *   - prompt overrides    → harness_shared.harness_prompt_overrides (000-baseline);
 *                           the judge rubric is stored under role = 'judge'.
 *   - proposer suggestions → harness_shared.gym_proposals (migration 110); accept
 *                           promotes proposed_md into harness_prompt_overrides.
 *   - autoloop config      → harness_shared.gym_autoloop_config (migration 110).
 *
 * Helpers take an injected `Sql` (the live operator admin pool) so the gym:* routes
 * and the gym loop's recorder share one tested core. Domain-free logic
 * (key validation, status summary) is split out + unit-tested in control-plane.test.ts;
 * the SQL is covered by control-plane.integration.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import type { LoopProposalRecord } from './loop';

/** The judge rubric is edited like a role prompt but isn't an AGENT_ROLES role. */
export const JUDGE_PROMPT_KEY = 'judge';

/** Every prompt key the gym UI may edit: the judge rubric + each harness role. */
export const GYM_PROMPT_KEYS: readonly string[] = [JUDGE_PROMPT_KEY, ...AGENT_ROLES];

const ROLE_SET: ReadonlySet<string> = new Set(AGENT_ROLES as readonly string[]);

export function isGymEditablePromptKey(key: string): boolean {
  return key === JUDGE_PROMPT_KEY || ROLE_SET.has(key);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GymProposalRow {
  id: string;
  workspaceId: string;
  harnessSlug: string;
  cycle: number;
  variantId: string | null;
  role: string;
  originalMd: string | null;
  proposedMd: string;
  rationale: string | null;
  devAnchorDelta: number | null;
  costDelta: number | null;
  probeStatus: string | null;
  /** pending | accepted | rejected | superseded */
  status: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface GymAutoloopConfig {
  workspaceId: string;
  harnessSlug: string;
  enabled: boolean;
  budgetUsd: number | null;
  spentUsd: number;
  /** idle | running | paused | exhausted */
  status: string;
  lastCycle: number | null;
  lastCycleAt: number | null;
  updatedAt: number;
}

export interface GymStatusSummary {
  pendingCount: number;
  lastCycle: number | null;
  autoloop: { enabled: boolean; status: string; budgetUsd: number | null; spentUsd: number } | null;
}

/** Pure: roll pending proposals + autoloop config into a per-harness status. */
export function summarizeGymStatus(
  pending: readonly Pick<GymProposalRow, 'cycle'>[],
  autoloop: GymAutoloopConfig | null,
): GymStatusSummary {
  const lastCycle = pending.length
    ? Math.max(...pending.map((p) => p.cycle))
    : autoloop?.lastCycle ?? null;
  return {
    pendingCount: pending.length,
    lastCycle,
    autoloop: autoloop
      ? { enabled: autoloop.enabled, status: autoloop.status, budgetUsd: autoloop.budgetUsd, spentUsd: autoloop.spentUsd }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Row mappers (postgres-js returns bigint as string; null-safe numeric coercion)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function mapProposal(r: Row): GymProposalRow {
  return {
    id: str(r.id),
    workspaceId: str(r.workspace_id),
    harnessSlug: str(r.harness_slug),
    cycle: Number(r.cycle),
    variantId: strOrNull(r.variant_id),
    role: str(r.role),
    originalMd: strOrNull(r.original_md),
    proposedMd: str(r.proposed_md),
    rationale: strOrNull(r.rationale),
    devAnchorDelta: numOrNull(r.dev_anchor_delta),
    costDelta: numOrNull(r.cost_delta),
    probeStatus: strOrNull(r.probe_status),
    status: str(r.status),
    createdAt: Number(r.created_at),
    decidedAt: numOrNull(r.decided_at),
  };
}

function mapAutoloop(r: Row): GymAutoloopConfig {
  return {
    workspaceId: str(r.workspace_id),
    harnessSlug: str(r.harness_slug),
    enabled: r.enabled === true || r.enabled === 't',
    budgetUsd: numOrNull(r.budget_usd),
    spentUsd: Number(r.spent_usd ?? 0),
    status: str(r.status),
    lastCycle: numOrNull(r.last_cycle),
    lastCycleAt: numOrNull(r.last_cycle_at),
    updatedAt: Number(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Prompts (harness_prompt_overrides; judge rubric under role='judge')
// ---------------------------------------------------------------------------

export async function getPrompts(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string },
): Promise<{ judgeRubric: string | null; roles: Record<string, string> }> {
  const rows = (await sql`
    SELECT role, prompt_md FROM harness_shared.harness_prompt_overrides
     WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}`) as Row[];
  let judgeRubric: string | null = null;
  const roles: Record<string, string> = {};
  for (const r of rows) {
    const role = str(r.role);
    if (role === JUDGE_PROMPT_KEY) judgeRubric = str(r.prompt_md);
    else roles[role] = str(r.prompt_md);
  }
  return { judgeRubric, roles };
}

export async function setPrompt(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string; role: string; md: string; now?: number },
): Promise<void> {
  if (!isGymEditablePromptKey(q.role)) {
    throw new Error(`gym: "${q.role}" is not an editable prompt key (expected 'judge' or an AGENT_ROLES role)`);
  }
  const now = q.now ?? Date.now();
  await sql`
    INSERT INTO harness_shared.harness_prompt_overrides (workspace_id, harness_slug, role, prompt_md, updated_at)
    VALUES (${q.workspaceId}, ${q.harnessSlug}, ${q.role}, ${q.md}, ${now})
    ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE
      SET prompt_md = EXCLUDED.prompt_md, updated_at = EXCLUDED.updated_at`;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface RecordProposalInput {
  workspaceId: string;
  harnessSlug: string;
  cycle: number;
  variantId?: string | null;
  role: string;
  originalMd?: string | null;
  proposedMd: string;
  rationale?: string | null;
  devAnchorDelta?: number | null;
  costDelta?: number | null;
  probeStatus?: string | null;
  /** Override the generated id (defaults to a deterministic variant+role key). */
  id?: string;
  now?: number;
}

/**
 * Upsert a proposal. The id is deterministic per (variant, role) so a retried
 * cycle is idempotent; the conflict-update only touches a still-PENDING row
 * (a decided proposal is never resurrected). Returns the proposal id.
 */
export async function recordProposal(sql: Sql, input: RecordProposalInput): Promise<string> {
  const id = input.id ?? (input.variantId ? `${input.variantId}__${input.role}` : randomUUID());
  const now = input.now ?? Date.now();
  await sql`
    INSERT INTO harness_shared.gym_proposals
      (id, workspace_id, harness_slug, cycle, variant_id, role, original_md, proposed_md, rationale,
       dev_anchor_delta, cost_delta, probe_status, status, created_at)
    VALUES (${id}, ${input.workspaceId}, ${input.harnessSlug}, ${input.cycle}, ${input.variantId ?? null}, ${input.role},
       ${input.originalMd ?? null}, ${input.proposedMd}, ${input.rationale ?? null},
       ${input.devAnchorDelta ?? null}, ${input.costDelta ?? null}, ${input.probeStatus ?? null}, 'pending', ${now})
    ON CONFLICT (id) DO UPDATE SET
       proposed_md = EXCLUDED.proposed_md, original_md = EXCLUDED.original_md, rationale = EXCLUDED.rationale,
       dev_anchor_delta = EXCLUDED.dev_anchor_delta, cost_delta = EXCLUDED.cost_delta,
       probe_status = EXCLUDED.probe_status, cycle = EXCLUDED.cycle
     WHERE gym_proposals.status = 'pending'`;
  return id;
}

export async function listProposals(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string; status?: string; variantId?: string },
): Promise<GymProposalRow[]> {
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_proposals
     WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}
       ${q.status ? sql`AND status = ${q.status}` : sql``}
       ${q.variantId ? sql`AND variant_id = ${q.variantId}` : sql``}
     ORDER BY cycle DESC, created_at DESC`) as Row[];
  return rows.map(mapProposal);
}

/**
 * Workspace-wide recent proposals across EVERY gym harness — the read behind the
 * Learning tab's Gym view (operator-learning-tab-2026-06-09). Newest-first, capped.
 * (The per-harness `listProposals` is the control surface; this is the cross-harness
 * "what has the gym been doing lately" rollup.)
 */
export async function listRecentProposalsForWorkspace(
  sql: Sql,
  q: { workspaceId: string; limit?: number },
): Promise<GymProposalRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_proposals
     WHERE workspace_id = ${q.workspaceId}
     ORDER BY created_at DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapProposal);
}

/** Every autoloop config in the workspace (one per gym harness), freshest first. */
export async function listAutoloopsForWorkspace(
  sql: Sql,
  q: { workspaceId: string },
): Promise<GymAutoloopConfig[]> {
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_autoloop_config
     WHERE workspace_id = ${q.workspaceId}
     ORDER BY updated_at DESC`) as Row[];
  return rows.map(mapAutoloop);
}

export interface DecideResult {
  ok: boolean;
  reason?: string;
  promoted?: boolean;
  proposal?: GymProposalRow;
}

/**
 * Accept or reject a pending proposal. Accept atomically promotes proposed_md into
 * harness_prompt_overrides (the role's prompt) AND marks the row accepted; reject
 * just marks it. Re-deciding a non-pending / missing row is a no-op (ok:false).
 */
export async function decideProposal(
  sql: Sql,
  q: { id: string; workspaceId: string; harnessSlug: string; decision: 'accepted' | 'rejected'; now?: number },
): Promise<DecideResult> {
  const now = q.now ?? Date.now();
  const run = async (tx: Sql): Promise<DecideResult> => {
    const rows = (await tx`
      SELECT * FROM harness_shared.gym_proposals
       WHERE id = ${q.id} AND workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}
       FOR UPDATE`) as Row[];
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const row = mapProposal(rows[0]);
    if (row.status !== 'pending') return { ok: false, reason: 'already_decided', proposal: row };

    const promoted = q.decision === 'accepted';
    if (promoted) {
      await tx`
        INSERT INTO harness_shared.harness_prompt_overrides (workspace_id, harness_slug, role, prompt_md, updated_at)
        VALUES (${q.workspaceId}, ${q.harnessSlug}, ${row.role}, ${row.proposedMd}, ${now})
        ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE
          SET prompt_md = EXCLUDED.prompt_md, updated_at = EXCLUDED.updated_at`;
    }
    await tx`UPDATE harness_shared.gym_proposals SET status = ${q.decision}, decided_at = ${now} WHERE id = ${q.id}`;
    return { ok: true, promoted, proposal: { ...row, status: q.decision, decidedAt: now } };
  };
  // Accept's promote + status-update must be atomic. Open our own transaction when handed a
  // top-level client; when the caller already runs us inside one (routeWithWorkspace passes a
  // TransactionSql, which has no `.begin`), run directly — it's already atomic in the outer tx.
  const begin = (sql as unknown as { begin?: unknown }).begin;
  return typeof begin === 'function' ? ((await sql.begin(run)) as DecideResult) : run(sql);
}

// ---------------------------------------------------------------------------
// Autoloop config
// ---------------------------------------------------------------------------

export async function getAutoloop(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string },
): Promise<GymAutoloopConfig | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_autoloop_config
     WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug} LIMIT 1`) as Row[];
  return rows.length ? mapAutoloop(rows[0]) : null;
}

export interface SetAutoloopInput {
  workspaceId: string;
  harnessSlug: string;
  enabled?: boolean;
  /** number sets a cap; null clears it; undefined leaves it unchanged. */
  budgetUsd?: number | null;
  spentUsd?: number;
  status?: string;
  lastCycle?: number | null;
  lastCycleAt?: number | null;
  now?: number;
}

/** Upsert the per-harness autoloop config; omitted fields are preserved. */
export async function setAutoloop(sql: Sql, q: SetAutoloopInput): Promise<GymAutoloopConfig> {
  const now = q.now ?? Date.now();
  const existing = await getAutoloop(sql, { workspaceId: q.workspaceId, harnessSlug: q.harnessSlug });
  const merged: GymAutoloopConfig = {
    workspaceId: q.workspaceId,
    harnessSlug: q.harnessSlug,
    enabled: q.enabled ?? existing?.enabled ?? false,
    budgetUsd: q.budgetUsd !== undefined ? q.budgetUsd : existing?.budgetUsd ?? null,
    spentUsd: q.spentUsd ?? existing?.spentUsd ?? 0,
    status: q.status ?? existing?.status ?? 'idle',
    lastCycle: q.lastCycle !== undefined ? q.lastCycle : existing?.lastCycle ?? null,
    lastCycleAt: q.lastCycleAt !== undefined ? q.lastCycleAt : existing?.lastCycleAt ?? null,
    updatedAt: now,
  };
  await sql`
    INSERT INTO harness_shared.gym_autoloop_config
      (workspace_id, harness_slug, enabled, budget_usd, spent_usd, status, last_cycle, last_cycle_at, updated_at)
    VALUES (${merged.workspaceId}, ${merged.harnessSlug}, ${merged.enabled}, ${merged.budgetUsd}, ${merged.spentUsd},
       ${merged.status}, ${merged.lastCycle}, ${merged.lastCycleAt}, ${merged.updatedAt})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE SET
       enabled = EXCLUDED.enabled, budget_usd = EXCLUDED.budget_usd, spent_usd = EXCLUDED.spent_usd,
       status = EXCLUDED.status, last_cycle = EXCLUDED.last_cycle, last_cycle_at = EXCLUDED.last_cycle_at,
       updated_at = EXCLUDED.updated_at`;
  return merged;
}

// ---------------------------------------------------------------------------
// Gym loop → control plane bridge
// ---------------------------------------------------------------------------

/**
 * Build a `deps.recordProposal` for runOptimizationLoop that writes each candidate's
 * CHANGED-role prompts into harness_shared.gym_proposals (pending) for human review.
 * Only roles whose merged prompt differs from the parent's are recorded (the diff);
 * inherited/unchanged roles are skipped. Bind this in the human-gated autoloop runner
 * (with autoPromote:false) so the gym surfaces scored suggestions the user accepts via
 * gym:accept. Also bumps the autoloop config's last_cycle each cycle.
 */
export function makeLoopProposalRecorder(
  sql: Sql,
  ctx: { workspaceId: string; harnessSlug: string; now?: () => number },
): (rec: LoopProposalRecord) => Promise<void> {
  const now = ctx.now ?? (() => Date.now());
  return async (rec: LoopProposalRecord) => {
    const parent = rec.parentOverlay.promptOverrides;
    const ts = now();
    for (const [role, proposedMd] of Object.entries(rec.overlay.promptOverrides)) {
      const originalMd = parent[role] ?? null;
      if (originalMd === proposedMd) continue; // unchanged inherited role — not a diff
      await recordProposal(sql, {
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.harnessSlug,
        cycle: rec.cycle,
        variantId: rec.candidateId,
        role,
        originalMd,
        proposedMd,
        rationale: rec.rationale,
        devAnchorDelta: rec.devAnchorDelta,
        costDelta: rec.costDelta,
        probeStatus: rec.probeStatus,
        now: ts,
      });
    }
    await setAutoloop(sql, {
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.harnessSlug,
      lastCycle: rec.cycle,
      lastCycleAt: ts,
      now: ts,
    });
  };
}
