/**
 * harness_shared.delegate_inbox helpers.
 *
 * Holds notifications for the EL agent that occurred while no session
 * was live. The classic case: a long async delegate finishes after the
 * user has closed the panel — sendContextualUpdate has nowhere to go.
 * We persist here; the next EL session connects, drains the inbox, and
 * delivers everything as a single contextual update on the first turn.
 *
 * Server-only.
 */
import { withWorkspace } from '@papercusp/db-org';

export interface DelegateInboxRow {
  id: number;
  workspaceId: string;
  createdAt: string;
  deliveredAt: string | null;
  kind: string;
  headline: string;
  agentSessionId: string | null;
}

export async function pushDelegateInbox(args: {
  workspaceId: string;
  headline: string;
  kind?: string;
  agentSessionId?: string | null;
}): Promise<number> {
  return withWorkspace(args.workspaceId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      INSERT INTO harness_shared.delegate_inbox (
        workspace_id, kind, headline, agent_session_id
      ) VALUES (
        ${args.workspaceId},
        ${args.kind ?? 'delegate-complete'},
        ${args.headline},
        ${args.agentSessionId ?? null}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  });
}

/**
 * Atomically read all undelivered rows + mark them delivered. Returns
 * the rows so the caller can fold them into a contextual update.
 *
 * If the caller fails to deliver (e.g. EL session disconnects between
 * the drain and sendContextualUpdate), the rows are still marked
 * delivered — we accept losing them rather than risk replaying every
 * future session forever.
 */
export async function drainDelegateInbox(opts: {
  workspaceId: string;
  limit?: number;
}): Promise<DelegateInboxRow[]> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<any[]>`
      UPDATE harness_shared.delegate_inbox SET delivered_at = now()
      WHERE id IN (
        SELECT id FROM harness_shared.delegate_inbox
        WHERE workspace_id = ${opts.workspaceId} AND delivered_at IS NULL
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, workspace_id, created_at, delivered_at, kind, headline, agent_session_id
    `;
    return rows.map(toRow);
  });
}

export async function peekDelegateInbox(opts: {
  workspaceId: string;
}): Promise<{ pending: number }> {
  return withWorkspace(opts.workspaceId, async (tx) => {
    const rows = await tx<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM harness_shared.delegate_inbox
      WHERE workspace_id = ${opts.workspaceId} AND delivered_at IS NULL
    `;
    return { pending: Number(rows[0]?.count ?? 0) };
  });
}

function toRow(r: any): DelegateInboxRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    deliveredAt: r.delivered_at ? (r.delivered_at instanceof Date ? r.delivered_at.toISOString() : r.delivered_at) : null,
    kind: r.kind,
    headline: r.headline,
    agentSessionId: r.agent_session_id ?? null,
  };
}
