/**
 * Operator audit-event writer (Phase 1b of the v5 operator plan).
 *
 * Lifecycle reducer writes two timestamps per card to
 * `harness_shared.audit_log.details` (JSON):
 *
 *   { card_id, dispatched_at, acked_at }
 *
 * Plus a separate `kind: 'undo_cancel'` event when the user cancels
 * within the 5s undo window — distinct from a deliberate dismiss
 * (which goes through the preferences-write path, not this one).
 *
 * Other state-flip timestamps (consumed_at, escalated_at, …) are
 * deferred to v1.5 per the plan; this module only emits the two the
 * Path-a escalation criterion needs.
 */

import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from './workspace-registry';

export type OperatorAuditKind = 'dispatched' | 'acked' | 'undo_cancel';

export interface OperatorAuditEvent {
  cardId: string;
  kind: OperatorAuditKind;
  /** ISO timestamp; defaults to now. */
  at?: string;
  /** Optional context (capability + target for dispatched events, etc). */
  context?: Record<string, unknown>;
}

function makeId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeOperatorAudit(ev: OperatorAuditEvent): Promise<void> {
  const workspaceId = activeWorkspaceId();
  const at = ev.at ?? new Date().toISOString();
  const id = makeId();
  const details = { card_id: ev.cardId, kind: ev.kind, at, ...(ev.context ?? {}) };
  try {
    await withWorkspace(workspaceId, async (tx) => {
      await tx`
        INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
        VALUES (
          ${id},
          ${Date.now()},
          'system:operator',
          ${`operator.${ev.kind}`},
          ${ev.cardId},
          ${tx.json(details)},
          ${workspaceId}
        )
      `;
    });
  } catch (err) {
    // Best-effort; never block the panel on a missing audit row.
    console.warn(`[operator-audit] failed to write ${ev.kind} for ${ev.cardId}:`, err);
  }
}
