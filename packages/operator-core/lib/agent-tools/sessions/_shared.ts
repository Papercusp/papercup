/**
 * Shared helpers for the sessions:* tool group (session-search-scope-2026-07-05
 * P-005/P-006). The corpus is harness_shared.session_turns (see
 * search/session-ingest.ts); these tools are the NAVIGATION verbs over it —
 * search stays in search:* / sessions:search per D-001/D-002 (corpus vs filter
 * vs fused-composition taxonomy).
 */

import type { Sql } from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

export const SESSION_SOURCE_KINDS = ['claude', 'omp', 'codex', 'agent_chat'] as const;
export const SESSION_TURN_REF_PREFIX = 'session_turn:';

export interface SessionTurnRef {
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
}

/** Canonical, directly-readable reference to one indexed transcript turn. */
export function formatSessionTurnRef(sourceKind: string, sessionId: string, turnIdx: number): string {
  return `${SESSION_TURN_REF_PREFIX}${sourceKind}:${sessionId}:${turnIdx}`;
}

/** Fail-open flag read — the flag's default is ON. */
export async function sessionSearchEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.SESSION_SEARCH, 'system:sessions-tools');
  } catch {
    return true;
  }
}

export function disabledResult(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ ok: false, error: 'feature_disabled', note: 'SESSION_SEARCH flag is off.' }),
    }],
    isError: true,
  };
}

export interface WindowTurn {
  ref: string;
  turn_idx: number;
  speaker: string;
  ts: string | null;
  text: string;
}

interface LiveRefreshDeps {
  resolve?: (ownerId: string) => Promise<{ filePath: string; sessionId: string } | null>;
  ingest?: (filePath: string, opts: { owner: string; sessionId: string }) => Promise<unknown>;
}

interface TargetSessionRow {
  id: number;
  agent: string | null;
  owner: string | null;
  session_id: string | null;
  omp_thread_id: string | null;
}

interface TargetRefreshDeps {
  resolve?: (
    sourceKind: string,
    sessionId: string,
    row: TargetSessionRow,
  ) => Promise<{ filePath: string; sessionId: string } | null>;
  ingest?: (filePath: string, opts: { owner: string; sessionId: string }) => Promise<unknown>;
}

async function resolveTargetSessionTranscript(
  sourceKind: string,
  sessionId: string,
  row: TargetSessionRow,
): Promise<{ filePath: string; sessionId: string } | null> {
  if (!row.owner) return null;

  if (sourceKind === 'claude') {
    const { findSessionTranscript } = await import('../../claude-sessions');
    const filePath = await findSessionTranscript(sessionId, { owner: row.owner });
    return filePath ? { filePath, sessionId } : null;
  }

  if (sourceKind === 'omp') {
    const { findOmpSessionPath } = await import('../../session-transcript-resolvers');
    const threadId = row.omp_thread_id ?? sessionId;
    const filePath = await findOmpSessionPath(threadId, { sessionKey: row.id });
    return filePath ? { filePath, sessionId } : null;
  }

  if (sourceKind === 'codex') {
    const [{ findCodexRolloutPathByUuid }, { codexHomeForSessionKey }] = await Promise.all([
      import('../../session-transcript-resolvers'),
      import('@papercusp/orchestrator/session-launch-dirs'),
    ]);
    const filePath = await findCodexRolloutPathByUuid(sessionId, {
      homeOverride: codexHomeForSessionKey(row.id),
    });
    return filePath ? { filePath, sessionId } : null;
  }

  return null;
}

/**
 * Refresh one explicitly requested live session immediately before reading its
 * indexed turns. Historical sessions deliberately skip this path, leaving the
 * existing index/archive behavior unchanged. The active adv_sessions lookup is
 * tenant-independent for the same reason as the owner fallback in sessions:list:
 * adv_sessions is tenant-keyed while the transcript corpus is stored in the
 * shared/default namespace.
 */
export async function refreshTargetSessionBeforeRead(
  sql: Sql,
  sourceKind: string | null | undefined,
  sessionId: string,
  deps: TargetRefreshDeps = {},
): Promise<{ attempted: number; refreshed: number }> {
  if (!sessionId || sourceKind === 'agent_chat') return { attempted: 0, refreshed: 0 };

  const rows = await sql<TargetSessionRow[]>`
    SELECT id, agent, coord_owner_id AS owner, session_id, omp_thread_id
      FROM harness_shared.adv_sessions
     WHERE ended_at IS NULL
       AND coord_owner_id IS NOT NULL
       AND (${sourceKind ?? null}::text IS NULL OR agent = ${sourceKind ?? null})
       AND (
         session_id = ${sessionId}
         OR (agent = 'omp' AND omp_thread_id = ${sessionId})
       )
  ORDER BY started_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  if (!row?.agent || !row.owner) return { attempted: 0, refreshed: 0 };

  const resolve = deps.resolve ?? resolveTargetSessionTranscript;
  const target = await resolve(row.agent, sessionId, row);
  if (!target) return { attempted: 1, refreshed: 0 };

  const ingest = deps.ingest ?? (await import('../../search/session-ingest')).ingestFileNow;
  await ingest(target.filePath, { owner: row.owner, sessionId: target.sessionId });
  return { attempted: 1, refreshed: 1 };
}

/**
 * Bring open Codex sessions into the indexed corpus immediately before a read.
 * Archive ingestion is intentionally not a freshness boundary: an active
 * session may not have reached either the periodic sweep or archive-at-death.
 * The owner set is bounded and refreshed concurrently to avoid a serial FS
 * walk on the unfiltered sessions:list path.
 */
export async function refreshLiveSessionsBeforeRead(
  sql: Sql,
  owners?: readonly string[] | null,
  deps: LiveRefreshDeps = {},
): Promise<{ attempted: number; refreshed: number }> {
  let ownerIds = [...new Set((owners ?? []).filter(Boolean))].slice(0, 20);
  if (ownerIds.length === 0) {
    const rows = await sql<Array<{ owner: string }>>`
      SELECT DISTINCT coord_owner_id AS owner
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NULL
         AND agent = 'codex'
         AND coord_owner_id IS NOT NULL
       ORDER BY coord_owner_id
       LIMIT 20`;
    ownerIds = rows.map((row) => row.owner);
  }
  if (ownerIds.length === 0) return { attempted: 0, refreshed: 0 };

  const resolve = deps.resolve ?? (await import('../../search/self-session')).resolveSelfSession;
  const ingest = deps.ingest ?? (await import('../../search/session-ingest')).ingestFileNow;
  const results = await Promise.all(ownerIds.map(async (owner) => {
    try {
      const live = await resolve(owner);
      if (!live) return false;
      await ingest(live.filePath, { owner, sessionId: live.sessionId });
      return true;
    } catch {
      return false;
    }
  }));
  return { attempted: ownerIds.length, refreshed: results.filter(Boolean).length };
}

/** ±context turns around one hit (per-turn text bounded for token economy). */
export async function hydrateWindow(
  sql: Sql,
  workspaceId: string,
  sourceKind: string,
  sessionId: string,
  aroundIdx: number,
  context: number,
  perTurnChars = 700,
): Promise<WindowTurn[]> {
  const lo = Math.max(0, aroundIdx - context);
  const hi = aroundIdx + context;
  const rows = await sql<Array<{ turn_idx: number; speaker: string; ts: string | null; text: string }>>`
    SELECT turn_idx, speaker, ts::text AS ts, left(text, ${perTurnChars}) AS text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${workspaceId} OR workspace_id = 'default')
       AND source_kind = ${sourceKind} AND session_id = ${sessionId}
       AND turn_idx BETWEEN ${lo} AND ${hi}
  ORDER BY turn_idx
  `;
  return rows.map((row) => ({
    ref: formatSessionTurnRef(sourceKind, sessionId, row.turn_idx),
    ...row,
  }));
}

/**
 * Parse either the search engine's compact source_id
 * (`<source_kind>:<session_id>:<turn_idx>`) or the public canonical reference
 * (`session_turn:<source_kind>:<session_id>:<turn_idx>`). Session ids may
 * themselves contain `:`, so the first/last separators are load-bearing.
 */
export function parseTurnRef(sourceIdOrRef: string): SessionTurnRef | null {
  const sourceId = sourceIdOrRef.startsWith(SESSION_TURN_REF_PREFIX)
    ? sourceIdOrRef.slice(SESSION_TURN_REF_PREFIX.length)
    : sourceIdOrRef;
  const first = sourceId.indexOf(':');
  const last = sourceId.lastIndexOf(':');
  if (first < 0 || last <= first) return null;
  const turnIdx = Number(sourceId.slice(last + 1));
  const sourceKind = sourceId.slice(0, first);
  const sessionId = sourceId.slice(first + 1, last);
  if (!Number.isInteger(turnIdx) || turnIdx < 0 || !sessionId || !SESSION_SOURCE_KINDS.includes(sourceKind as never)) {
    return null;
  }
  return { sourceKind, sessionId, turnIdx };
}
