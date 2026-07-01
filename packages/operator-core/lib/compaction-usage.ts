/**
 * compaction-usage.ts — best-effort per-session context-size estimator.
 * agent-managed-compaction-2026-07-01 (P-007 / P-009).
 *
 * Resolves a session's transcript from its coord ownerId (via adv_sessions) and
 * estimates current context tokens as transcript-bytes/4 — a cheap, monotonic
 * "how full am I" gauge (fs.stat only, no content read). Runs OFF the per-turn hot
 * path: the compaction-compliance watchdog calls it on a cadence and caches the
 * result on coord_presence.context_tokens; the inbox usage signal reads that cached
 * value. Degrades to null (never throws) when a transcript can't be resolved.
 *
 * v1 targets Claude (interactive AND spawned — adv_sessions maps both). OMP
 * self-compacts natively and Codex has no compaction, so both return null for now
 * (a follow-up can add OMP via OmpSessionUsage).
 */
import * as fs from 'node:fs';
import { findSessionTranscript } from './claude-sessions';

export interface SessionRef {
  /** Backend: 'claude' | 'omp' | 'codex' | null (unknown → treated as claude). */
  agent: string | null;
  /** The backend session id (Claude UUID / OMP thread / codex rollout). */
  sessionId: string | null;
}

/** tokens ≈ transcript bytes / 4 (chars/4; JSON overhead makes it a slight
 *  over-estimate — fine for a fullness gauge). fs.stat only, no content read. */
function tokensFromFileSize(pathStr: string): number | null {
  try {
    return Math.floor(fs.statSync(pathStr).size / 4);
  } catch {
    return null;
  }
}

/**
 * Estimate a session's current context tokens from a resolved SessionRef.
 * Claude (+ unknown) → transcript bytes/4; OMP/Codex → null in v1.
 */
export async function estimateContextTokens(ref: SessionRef, owner?: string | null): Promise<number | null> {
  if (!ref.sessionId) return null;
  if (ref.agent === 'omp' || ref.agent === 'codex') return null;
  try {
    // Pass the coord `owner` hint: an interactive/spawned session's transcript lives under
    // ~/.papercusp/session-claude/<owner>/projects, so the hint takes findSessionTranscript's
    // FAST PATH (one owner-root readdir) instead of the full 12k-owner-dir sweep. Without it,
    // the compaction watchdog polling many owners on a cadence re-swept every isolation root
    // per call — the fs-churn that bloated the background host to tens of GB.
    const p = await findSessionTranscript(ref.sessionId, { owner: owner ?? null });
    return p ? tokensFromFileSize(p) : null;
  } catch {
    return null;
  }
}

/** Resolve a session's {agent, sessionId} from its coord ownerId via adv_sessions. */
export async function resolveSessionRef(ownerId: string): Promise<SessionRef | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ agent: string | null; session_id: string | null }[]>`
      SELECT agent, session_id
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND session_id IS NOT NULL
       LIMIT 1
    `;
    if (!rows.length) return null;
    return { agent: rows[0].agent, sessionId: rows[0].session_id };
  } catch {
    return null;
  }
}

/** Best-effort context-token estimate for a session by its coord ownerId. */
export async function estimateContextTokensForOwner(ownerId: string): Promise<number | null> {
  const ref = await resolveSessionRef(ownerId);
  return ref ? estimateContextTokens(ref, ownerId) : null;
}
