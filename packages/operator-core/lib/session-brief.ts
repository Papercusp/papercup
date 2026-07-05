/**
 * session-brief.ts — durable successor brief for "continue where X left off" (EI-1742).
 *
 * GAP: an agent's declared LANE lives only in harness_shared.coord_presence, which the
 * idle-session-reaper DELETEs once the row goes stale. A successor told "continue where
 * X left off" then has no durable record of X's intent/plan/files and reconstructs the
 * lane from transcript / file-history archaeology (slow + lossy). Both observed cases
 * (su-226ad rate-limited, su-cf7b0 MCP-dropped) died ABRUPTLY — a session-end snapshot
 * hook would have missed them.
 *
 * FIX (consensus su-7dcd + su-cf7b0, EI-1742): persist the lane on the write path that
 * already runs throughout a session — coord:declare-intent → writePresence (see
 * presence.ts) — into harness_shared.session_briefs (migration 322), which the reaper
 * never touches. The LAST declare-intent before the session dies IS the durable brief.
 *
 * This module is the host adapter for that durable store. The write is best-effort and
 * fully isolated: any failure is swallowed so it can NEVER slow or break a presence
 * write (the change degrades to exactly today's behavior). Claimed items are NOT stored
 * here — they are already durable in work_items (queryable by assignee).
 *
 * Read side: getSessionBrief() is the seed a continuing session reads. Auto-injection
 * into assembleSpawnHydration's "## Handoff" block is the Phase-2 follow-up (it needs
 * the launch path to pass the continuation target; for native_session_id resolution see
 * the bootstrap-su adv row that records the Claude session UUID).
 */

import { getOrgPg } from '@papercusp/db-org';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The subset of presence input that forms the durable brief. */
export interface SessionBriefInput {
  intent?: string;
  currentPlanSlug?: string | null;
  currentFiles?: string[];
  /** Harness the work is in (the agent's home harness). */
  harnessSlug?: string | null;
  /** Resolved home hive, if any. */
  hiveSlug?: string | null;
  /**
   * The Claude/native session UUID, if the caller has it. declare-intent's context
   * carries only ownerId today, so this is usually null; reserved for the Phase-2
   * "continue where session <uuid> left off" lookup key.
   */
  nativeSessionId?: string | null;
}

export interface SessionBriefRecord {
  ownerId: string;
  workspaceId: string;
  ownerLabel: string;
  source: string;
  intent: string;
  currentPlanSlug: string | null;
  currentFiles: string[];
  harnessSlug: string | null;
  hiveSlug: string | null;
  nativeSessionId: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/**
 * Best-effort upsert of the caller's durable successor brief. Called from
 * writePresence after the presence row is written. NEVER throws: a failure here must
 * not affect presence/declare-intent (the table may even be absent on a node that has
 * not yet applied migration 322 — that simply no-ops).
 */
export async function writeSessionBrief(
  identity: AgentIdentity,
  input: SessionBriefInput = {},
): Promise<void> {
  try {
    if (!identity?.ownerId) return;
    const sql = getOrgPg().sql;
    await sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id, workspace_id, owner_label, source, intent,
         current_plan_slug, current_files, harness_slug, pot_slug,
         native_session_id, first_seen_at, updated_at)
      VALUES (
        ${identity.ownerId},
        ${identity.workspaceId ?? 'default'},
        ${identity.ownerLabel ?? ''},
        ${identity.source ?? ''},
        ${input.intent ?? ''},
        ${input.currentPlanSlug ?? null},
        ${JSON.stringify(input.currentFiles ?? [])}::text::jsonb,
        ${input.harnessSlug ?? null},
        ${input.hiveSlug ?? null},
        ${input.nativeSessionId ?? null},
        now(), now()
      )
      ON CONFLICT (owner_id) DO UPDATE SET
        workspace_id      = EXCLUDED.workspace_id,
        owner_label       = EXCLUDED.owner_label,
        source            = EXCLUDED.source,
        intent            = EXCLUDED.intent,
        current_plan_slug = EXCLUDED.current_plan_slug,
        current_files     = EXCLUDED.current_files,
        -- populate-once-then-keep: a write that omits harness/hive/session never WIPES
        -- a previously-resolved value (mirrors coord_presence D-004).
        harness_slug      = COALESCE(EXCLUDED.harness_slug, harness_shared.session_briefs.harness_slug),
        pot_slug         = COALESCE(EXCLUDED.pot_slug, harness_shared.session_briefs.pot_slug),
        native_session_id = COALESCE(EXCLUDED.native_session_id, harness_shared.session_briefs.native_session_id),
        updated_at        = now()
    `;
  } catch {
    /* best-effort: the brief must never break a presence write (EI-1742). */
  }
}

function rowToRecord(r: Record<string, unknown>): SessionBriefRecord {
  return {
    ownerId: String(r.owner_id),
    workspaceId: String(r.workspace_id),
    ownerLabel: String(r.owner_label ?? ''),
    source: String(r.source ?? ''),
    intent: String(r.intent ?? ''),
    currentPlanSlug: (r.current_plan_slug as string | null) ?? null,
    currentFiles: Array.isArray(r.current_files) ? (r.current_files as string[]) : [],
    harnessSlug: (r.harness_slug as string | null) ?? null,
    hiveSlug: (r.pot_slug as string | null) ?? null,
    nativeSessionId: (r.native_session_id as string | null) ?? null,
    firstSeenAt: String(r.first_seen_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

/**
 * Read a durable successor brief for a continuing session. Resolve by ownerId
 * (the common "continue where owner X left off") or by nativeSessionId (the Claude
 * session UUID a "continue where session <uuid> left off" names — populated once the
 * write path carries it; Phase 2). Returns null when absent or on any error (fail-soft).
 */
export async function getSessionBrief(
  query: { ownerId?: string | null; nativeSessionId?: string | null },
): Promise<SessionBriefRecord | null> {
  try {
    const sql = getOrgPg().sql;
    if (query.ownerId) {
      const rows = await sql`
        SELECT * FROM harness_shared.session_briefs WHERE owner_id = ${query.ownerId} LIMIT 1
      `;
      return rows[0] ? rowToRecord(rows[0] as Record<string, unknown>) : null;
    }
    if (query.nativeSessionId) {
      const rows = await sql`
        SELECT * FROM harness_shared.session_briefs
        WHERE native_session_id = ${query.nativeSessionId}
        ORDER BY updated_at DESC LIMIT 1
      `;
      return rows[0] ? rowToRecord(rows[0] as Record<string, unknown>) : null;
    }
    return null;
  } catch {
    return null;
  }
}
