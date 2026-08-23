/**
 * gate-store.ts — the Postgres layer for session_pending_gates (migration 619,
 * owner-inbox-single-pane-2026-07-17 P-002): the client-agnostic owner-gate
 * tracker fed by both the ingest tool (hook push path) and the transcript
 * watcher (client-agnostic pull path, gate-watch.ts).
 *
 * `ref_id` is the correlation key across the open→close pair: the watcher uses
 * the transcript's own tool_use id; a hook generates its own uuid and repeats
 * it on the matching 'cleared' ingest event. The (workspace_id, session_id,
 * ref_id) unique index makes re-observing the same open ask idempotent — the
 * ON CONFLICT touch is scoped to still-open rows so a stale re-observation can
 * never reopen an already-closed gate.
 */
import { getOrgPg } from '@papercusp/db-org';

export type GateClient = 'claude' | 'omp' | 'codex';
export type GateKind = 'ask' | 'permission_wait';
export type GateSource = 'watcher' | 'hook';
export type GateClosedReason = 'tool_result_observed' | 'hook_cleared';

export interface PendingGateRow {
  id: string;
  workspace_id: string;
  session_id: string;
  client: GateClient;
  kind: GateKind;
  ref_id: string;
  owner_id: string | null;
  question: string | null;
  options: Array<{ label: string; description?: string }> | null;
  source: GateSource;
  raw_ref: string | null;
  harness_slug: string | null;
  opened_at: string;
  closed_at: string | null;
  closed_reason: GateClosedReason | null;
  created_at: string;
}

export interface OpenGateInput {
  workspaceId: string;
  sessionId: string;
  client: GateClient;
  kind: GateKind;
  refId: string;
  ownerId?: string | null;
  question?: string | null;
  options?: Array<{ label: string; description?: string }> | null;
  source: GateSource;
  rawRef?: string | null;
  harnessSlug?: string | null;
}

export type OpenGateOutcome = 'opened' | 'already_open';

/**
 * Open (or idempotently touch) a pending gate. The `WHERE
 * session_pending_gates.closed_at IS NULL` conflict-action guard means a
 * re-observation of a REF that already closed is a true no-op — it can never
 * reopen a resolved gate (both producers may observe the same ask more than
 * once; the watcher especially re-sees an unresolved tool_use every tick).
 */
export async function openOrTouchGate(input: OpenGateInput): Promise<{ id: string; outcome: OpenGateOutcome }> {
  const { sql } = getOrgPg();
  const optionsJson = input.options ? JSON.stringify(input.options) : null;
  const rows = await sql<Array<{ id: string; opened_at: string; touched_opened_at: string }>>`
    INSERT INTO harness_shared.session_pending_gates
      (workspace_id, session_id, client, kind, ref_id, owner_id, question, options, source, raw_ref, harness_slug)
    VALUES (
      ${input.workspaceId}, ${input.sessionId}, ${input.client}, ${input.kind}, ${input.refId},
      ${input.ownerId ?? null}, ${input.question ?? null}, ${optionsJson}::text::jsonb,
      ${input.source}, ${input.rawRef ?? null}, ${input.harnessSlug ?? null}
    )
    ON CONFLICT (workspace_id, session_id, ref_id) DO UPDATE
      SET updated_at = now()
      WHERE session_pending_gates.closed_at IS NULL
    RETURNING id::text AS id, opened_at::text AS opened_at, updated_at::text AS touched_opened_at
  `;
  const row = rows[0];
  if (!row) {
    // The conflict-action WHERE excluded the row (already closed) AND it
    // wasn't a fresh insert either — look it up to report its id honestly.
    const existing = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM harness_shared.session_pending_gates
      WHERE workspace_id = ${input.workspaceId} AND session_id = ${input.sessionId} AND ref_id = ${input.refId}
    `;
    return { id: existing[0]?.id ?? '', outcome: 'already_open' };
  }
  const outcome: OpenGateOutcome = row.opened_at === row.touched_opened_at ? 'opened' : 'already_open';
  return { id: row.id, outcome };
}

export type CloseGateResult = 'closed' | 'not_found' | 'already_closed';

/** Close a gate by its correlation ref. Idempotent: closing an already-closed
 *  or never-opened ref is reported, never an error. */
export async function closeGate(input: {
  workspaceId: string;
  sessionId: string;
  refId: string;
  reason: GateClosedReason;
}): Promise<CloseGateResult> {
  const { sql } = getOrgPg();
  const updated = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.session_pending_gates
       SET closed_at = now(), closed_reason = ${input.reason}, updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND session_id = ${input.sessionId}
       AND ref_id = ${input.refId}
       AND closed_at IS NULL
     RETURNING id::text AS id
  `;
  if (updated.length > 0) return 'closed';
  const existing = await sql<Array<{ closed_at: string | null }>>`
    SELECT closed_at::text AS closed_at FROM harness_shared.session_pending_gates
    WHERE workspace_id = ${input.workspaceId} AND session_id = ${input.sessionId} AND ref_id = ${input.refId}
  `;
  if (existing.length === 0) return 'not_found';
  return 'already_closed';
}

/**
 * Close every still-open gate for a session by transcript tool_use id — the
 * watcher's job when it sees a tool_result line. Returns the closed count.
 */
export async function closeGateByToolUseId(input: {
  workspaceId: string;
  sessionId: string;
  toolUseId: string;
}): Promise<number> {
  const { sql } = getOrgPg();
  const updated = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.session_pending_gates
       SET closed_at = now(), closed_reason = 'tool_result_observed', updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND session_id = ${input.sessionId}
       AND ref_id = ${input.toolUseId}
       AND closed_at IS NULL
     RETURNING id::text AS id
  `;
  return updated.length;
}

/** The blocked-sessions surface + the attention adapter's read: open gates,
 *  oldest-blocking-first by default (the longest-waiting session is the most
 *  actionable). */
export async function listPendingGates(filter: {
  workspaceId: string;
  sessionId?: string;
  includeClosed?: boolean;
  order?: 'oldest' | 'newest';
  limit?: number;
}): Promise<PendingGateRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = await sql<PendingGateRow[]>`
    SELECT g.id::text AS id, g.workspace_id, g.session_id, g.client, g.kind, g.ref_id,
           COALESCE(g.owner_id, latest_owner.coord_owner_id) AS owner_id,
           g.question, g.options, g.source, g.raw_ref, g.harness_slug,
           g.opened_at::text AS opened_at, g.closed_at::text AS closed_at,
           g.closed_reason, g.created_at::text AS created_at
    FROM harness_shared.session_pending_gates AS g
    LEFT JOIN LATERAL (
      SELECT s.coord_owner_id
        FROM harness_shared.adv_sessions AS s
       WHERE s.workspace_id = g.workspace_id
         AND s.session_id = g.session_id
         AND s.coord_owner_id IS NOT NULL
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT 1
    ) AS latest_owner ON true
    WHERE g.workspace_id = ${filter.workspaceId}
      ${filter.includeClosed ? sql`` : sql`AND g.closed_at IS NULL`}
      ${filter.sessionId ? sql`AND g.session_id = ${filter.sessionId}` : sql``}
    ORDER BY g.opened_at ${filter.order === 'newest' ? sql`DESC` : sql`ASC`}
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * Closed `ask` gates (an AskUserQuestion the owner actually answered) since a
 * given ISO timestamp — the feed `decision-owed-source.ts` (EI-147) scans for
 * possibly-unrecorded owner decisions. Distinct from {@link listPendingGates}
 * (which defaults to still-OPEN gates and covers both kinds): this reads the
 * RESOLVED-ask history, newest-first, bounded by `sinceIso` so a long-lived
 * workspace never full-scans the table.
 */
export async function listClosedAskGatesSince(filter: {
  workspaceId: string;
  sinceIso: string;
  limit?: number;
}): Promise<PendingGateRow[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = await sql<PendingGateRow[]>`
    SELECT id::text AS id, workspace_id, session_id, client, kind, ref_id, owner_id, question, options,
           source, raw_ref, harness_slug, opened_at::text AS opened_at, closed_at::text AS closed_at,
           closed_reason, created_at::text AS created_at
    FROM harness_shared.session_pending_gates
    WHERE workspace_id = ${filter.workspaceId}
      AND kind = 'ask'
      AND closed_at IS NOT NULL
      AND closed_at >= ${filter.sinceIso}
    ORDER BY closed_at DESC
    LIMIT ${limit}
  `;
  return rows;
}
