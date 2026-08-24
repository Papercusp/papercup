/**
 * Shared terminal-action dispatcher for one AttentionItem.
 *
 * The desktop Inbox and the owner-authorised bulk resolver must not maintain
 * separate `(ref.kind, actionId) -> backend effect` switches.  This module owns
 * that switch and accepts injected effects so the browser can use its HTTP
 * helpers while the server-side resolver uses in-process tool dispatch.
 *
 * Navigation actions are deliberately rejected as non-terminal.  Callers must
 * also validate that `actionId` is currently offered by the item before entering
 * this function; the bulk resolver does that while holding its run authority.
 */

import { isNavigateAction } from './types';

export interface TerminalAttentionItem {
  id: string;
  kind: string;
  title: string;
  harnessSlug?: string | null;
  planSlug?: string | null;
  ownerAgentId?: string | null;
  ref: { kind: string; [key: string]: unknown };
}

export interface TerminalActionResult {
  resolved: boolean;
  live?: boolean;
  woken?: number;
}

export interface TerminalActionDependencies {
  resolveEscalation(input: { msgId: string; choice: string }): Promise<void>;
  acknowledgeMessage(input: { msgId: string }): Promise<void>;
  setPlanItemStatus(input: {
    slug: string;
    itemId: string;
    status: 'done' | 'dropped';
    /** Audit rationale — plans:set-status REQUIRES a nonblank reason for `dropped`. */
    rationale?: string;
  }): Promise<void>;
  /** Best-effort brain nudge after `done`; Drop intentionally never calls it. */
  wakePlanLoop(input: { harnessSlug: string | null; reason: string }): Promise<void> | void;
  dismissImprovement(input: { issueId: string }): Promise<void>;
  decideStandingApproval(input: {
    capability: string;
    targetHarness: string;
    decision: 'approve' | 'dismiss';
  }): Promise<void>;
  triageAttentionItem(input: {
    itemId: string;
    action: 'resolve';
    note: string;
  }): Promise<void>;
  /**
   * Best-effort owner-authoritative reply delivery for named escalation picks.
   * The browser injects its admin-only route.  The bulk resolver injects the
   * same underlying server helper, but only from its run-authority-guarded tool.
   */
  deliverOwnerReply?(input: {
    askerId: string;
    text: string;
    summary: string;
    planSlug?: string;
  }): Promise<{ live: boolean; woken: number }>;
}

function refString(item: TerminalAttentionItem, key: string): string {
  return String(item.ref[key] ?? '');
}

function escalationOptions(item: TerminalAttentionItem): Array<{ id: string; label: string }> {
  if (item.ref.kind !== 'coord-escalation' || !Array.isArray(item.ref.options)) return [];
  return (item.ref.options as unknown[]).filter(
    (value): value is { id: string; label: string } =>
      Boolean(
        value &&
          typeof value === 'object' &&
          typeof (value as { id?: unknown }).id === 'string' &&
          typeof (value as { label?: unknown }).label === 'string',
      ),
  );
}

export async function dispatchAttentionTerminalAction(input: {
  item: TerminalAttentionItem;
  actionId: string;
  deps: TerminalActionDependencies;
  /** Caller's audit rationale, threaded into effects that require a reason (plan-item drops). */
  rationale?: string;
}): Promise<TerminalActionResult> {
  const { item, actionId, deps, rationale } = input;
  if (isNavigateAction(actionId)) return { resolved: false };

  if (item.ref.kind === 'coord-escalation') {
    const named = escalationOptions(item).find((option) => option.id === actionId);
    if (!named && actionId !== 'resolve' && actionId !== 'mark-done') return { resolved: false };

    await deps.resolveEscalation({
      msgId: refString(item, 'msgId'),
      choice: named?.id ?? 'resolved',
    });

    // Resolution is already durable. Reply delivery is intentionally
    // best-effort, matching the owner-click path: a transient wake fault must
    // not make the caller repeat a terminal resolve.
    if (item.ownerAgentId && deps.deliverOwnerReply) {
      try {
        const reply = await deps.deliverOwnerReply({
          askerId: item.ownerAgentId,
          text: named?.label ?? 'Resolved',
          summary: `Owner answered your ${item.kind} (${item.id})`,
          ...(item.planSlug ? { planSlug: item.planSlug } : {}),
        });
        return { resolved: true, live: reply.live, woken: reply.woken };
      } catch {
        // Best-effort after a successful resolve; never invite a duplicate.
      }
    }
    return { resolved: true };
  }

  if (item.ref.kind === 'coord-message' && actionId === 'ack') {
    await deps.acknowledgeMessage({ msgId: refString(item, 'msgId') });
    return { resolved: true };
  }

  if (item.ref.kind === 'plan-item') {
    const status = actionId === 'mark-done' || actionId === 'resolve'
      ? 'done'
      : actionId === 'drop'
        ? 'dropped'
        : null;
    if (status) {
      await deps.setPlanItemStatus({
        slug: refString(item, 'slug'),
        itemId: refString(item, 'itemId'),
        status,
        ...(rationale ? { rationale } : {}),
      });
      if (status === 'done') {
        try {
          await deps.wakePlanLoop({
            harnessSlug: item.harnessSlug ?? null,
            reason: 'Attention item resolved — pick up the unblocked work',
          });
        } catch {
          // The persisted status is authoritative; the armed loop is fallback.
        }
      }
      return { resolved: true };
    }
  }

  if (item.ref.kind === 'improvement' && actionId === 'dismiss') {
    await deps.dismissImprovement({ issueId: refString(item, 'issueId') });
    return { resolved: true };
  }

  if (item.ref.kind === 'standing-approval' && (actionId === 'grant' || actionId === 'dismiss')) {
    await deps.decideStandingApproval({
      capability: refString(item, 'capability'),
      targetHarness: refString(item, 'targetHarness'),
      decision: actionId === 'grant' ? 'approve' : 'dismiss',
    });
    return { resolved: true };
  }

  if (item.ref.kind === 'operator-report' && (actionId === 'resolve' || actionId === 'mark-done')) {
    await deps.triageAttentionItem({
      itemId: item.id,
      action: 'resolve',
      note: 'Resolved from the inbox detail pane',
    });
    return { resolved: true };
  }

  return { resolved: false };
}
