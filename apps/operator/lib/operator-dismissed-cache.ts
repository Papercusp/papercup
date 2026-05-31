/**
 * Dismissed-suggestion cooldown.
 *
 * Tracks `(id, dismissedAt)` so a suggestion the user explicitly
 * dismissed isn't re-emitted within `cooldownMs` (default 1h).
 *
 * Backed by `harness_shared.operator_dismissed_cards` (migration 015).
 * Was previously file-primary at `<papercuspRoot>/system/operator/dismissed.json`
 * with PG as a best-effort mirror — the relationship is now flipped:
 * PG is the source of truth, the file is gone. Calls become async.
 *
 * Multi-machine sync was the reason PG existed at all; flipping primary
 * to PG means a 2nd device sees dismissals immediately.
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

interface DismissedEntry {
  id: string;
  dismissedAt: string; // ISO
}

export async function recordDismissed(id: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.operator_dismissed_cards (workspace_id, card_id, dismissed_at)
      VALUES (${workspaceId}, ${id}, now())
      ON CONFLICT (workspace_id, card_id) DO UPDATE
        SET dismissed_at = EXCLUDED.dismissed_at
    `;
  });
}

export async function isOnCooldown(id: string, cooldownMs: number = DEFAULT_COOLDOWN_MS): Promise<boolean> {
  const workspaceId = activeWorkspaceId();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ dismissed_at: string }[]>`
      SELECT dismissed_at::text
        FROM harness_shared.operator_dismissed_cards
       WHERE workspace_id = ${workspaceId} AND card_id = ${id}
       LIMIT 1
    `;
  });
  if (!rows.length) return false;
  return Date.now() - new Date(rows[0].dismissed_at).getTime() < cooldownMs;
}

export async function listDismissed(): Promise<DismissedEntry[]> {
  const workspaceId = activeWorkspaceId();
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ card_id: string; dismissed_at: string }[]>`
      SELECT card_id, dismissed_at::text
        FROM harness_shared.operator_dismissed_cards
       WHERE workspace_id = ${workspaceId}
         AND dismissed_at > now() - interval '7 days'
       ORDER BY dismissed_at DESC
    `;
  });
  return rows.map((r) => ({
    id: r.card_id,
    dismissedAt: new Date(r.dismissed_at).toISOString(),
  }));
}
