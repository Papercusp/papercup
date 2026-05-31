/**
 * Card reconstruction merge (Phase 1b-2 of the v5 operator plan).
 *
 * Reopen-the-panel hydration combines three sources:
 *   1. `last-scan.json` — the most-recent scan's emitted cards
 *   2. `audit_log` rows — `actor='system:operator'` AND
 *      `action LIKE 'operator.%'` AND `ts > now()-1h`. Tells us which
 *      cards have been dispatched / dismissed / undo-cancelled since.
 *   3. `dismissed.json` — the dismissed-cooldown cache.
 *
 * The merge produces a unified `cards[]` with the right `status` per
 * card so the panel doesn't lose the user's decisions across page
 * reloads or workspace switches.
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { readLastScan } from './operator-last-scan';
import { listDismissed } from './operator-dismissed-cache';

export type ReconstructedStatus =
  | 'pending'
  | 'dispatched'
  | 'dismissed'
  | 'consumed'
  | 'escalated'
  | 'rejected'
  | 'failed'
  | 'superseded';

export interface ReconstructedCard {
  id: string;
  /** Suggestion payload as the panel originally consumed it. */
  payload: Record<string, unknown>;
  status: ReconstructedStatus;
  dispatchedAt?: number;
  ackedAt?: number;
  undoCancelled?: boolean;
}

interface AuditRow {
  ts: number;
  action: string;
  subject: string; // card id
  details: Record<string, unknown>;
}

const RECONSTRUCT_WINDOW_MS = 60 * 60 * 1000; // 1h per plan §1b

export async function reconstructCards(): Promise<ReconstructedCard[]> {
  const last = await readLastScan();
  if (!last) return [];

  const dismissedIds = new Set((await listDismissed()).map((e) => e.id));

  let auditRows: AuditRow[] = [];
  try {
    const workspaceId = activeWorkspaceId();
    auditRows = await withWorkspace(workspaceId, async (tx) => {
      return tx<AuditRow[]>`
        SELECT ts, action, subject, details
          FROM harness_shared.audit_log
         WHERE actor  = 'system:operator'
           AND action LIKE 'operator.%'
           AND ts     >= ${Date.now() - RECONSTRUCT_WINDOW_MS}
         ORDER BY ts ASC
      `;
    });
  } catch {
    /* PG unavailable — fall back to last-scan + dismissed only */
  }

  // Reduce audit rows per card_id (subject) to a final lifecycle status
  // and timestamps. Last write wins for status; both timestamps are kept.
  const lifecycle = new Map<string, { status?: ReconstructedStatus; dispatchedAt?: number; ackedAt?: number; undoCancelled?: boolean }>();
  for (const row of auditRows) {
    const cur = lifecycle.get(row.subject) ?? {};
    const kind = row.action.replace(/^operator\./, '');
    if (kind === 'dispatched') {
      cur.status = 'dispatched';
      cur.dispatchedAt = row.ts;
    } else if (kind === 'acked') {
      // Don't downgrade if status already advanced past dispatched.
      if (cur.status === 'dispatched' || cur.status === undefined) {
        cur.status = 'dispatched';
      }
      cur.ackedAt = row.ts;
    } else if (kind === 'undo_cancel') {
      cur.status = 'dismissed';
      cur.undoCancelled = true;
    }
    lifecycle.set(row.subject, cur);
  }

  const out: ReconstructedCard[] = [];
  for (const card of last.cards) {
    const id = typeof card.id === 'string' ? card.id : '';
    if (!id) continue;
    const audit = lifecycle.get(id);
    let status: ReconstructedStatus = 'pending';
    if (audit?.status) status = audit.status;
    else if (dismissedIds.has(id)) status = 'dismissed';
    out.push({
      id,
      payload: card,
      status,
      dispatchedAt: audit?.dispatchedAt,
      ackedAt: audit?.ackedAt,
      undoCancelled: audit?.undoCancelled,
    });
  }
  return out;
}
