/**
 * memory-feedback signal capture.
 *
 * Records every user-driven mutation of a memory (edit, delete,
 * forget_all) into harness_shared.memory_feedback (migration 062).
 * Future learning signal: which memories get edited shortly after
 * creation, deletion patterns by kind, etc.
 *
 * Best-effort: failures are logged and swallowed — the user-facing
 * API operation must never fail because feedback capture failed.
 */

import { activeWorkspaceId } from '../workspace-registry';

export interface FeedbackInput {
  memId: string;
  userId: string;
  action: 'edit' | 'delete' | 'forget_all';
  kind?: string | null;
  priorText?: string | null;
  newText?: string | null;
}

export async function recordFeedback(input: FeedbackInput): Promise<void> {
  try {
    const { pgClientFields } = await import('./mem0-connection');
    const fields = await pgClientFields();
    if (!fields) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      await c.query(
        `INSERT INTO harness_shared.memory_feedback
           (mem_id, user_id, workspace_id, action, kind, prior_text, new_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.memId,
          input.userId,
          activeWorkspaceId(),
          input.action,
          input.kind ?? null,
          input.priorText ?? null,
          input.newText ?? null,
        ],
      );
    } finally {
      await c.end();
    }
  } catch (err) {
    console.warn('[memory-feedback] capture failed:', (err as Error).message);
  }
}

export interface FeedbackStats {
  total_edits: number;
  total_deletes: number;
  recent: Array<{
    id: string;
    mem_id: string;
    action: string;
    prior_text: string | null;
    new_text: string | null;
    created_at: string;
  }>;
}

export async function loadFeedbackStats(
  userId: string,
  recentLimit = 20,
): Promise<FeedbackStats | null> {
  try {
    const { pgClientFields } = await import('./mem0-connection');
    const fields = await pgClientFields();
    if (!fields) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      const counts = await c.query(
        `SELECT action, COUNT(*)::int AS n
           FROM harness_shared.memory_feedback
          WHERE user_id = $1
          GROUP BY action`,
        [userId],
      );
      const byAction = Object.fromEntries(
        counts.rows.map((r: { action: string; n: number }) => [r.action, r.n]),
      ) as Record<string, number>;
      const recent = await c.query(
        `SELECT id, mem_id, action, prior_text, new_text, created_at
           FROM harness_shared.memory_feedback
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, recentLimit],
      );
      return {
        total_edits: byAction.edit ?? 0,
        total_deletes: (byAction.delete ?? 0) + (byAction.forget_all ?? 0),
        recent: recent.rows as FeedbackStats['recent'],
      };
    } finally {
      await c.end();
    }
  } catch {
    return null;
  }
}
