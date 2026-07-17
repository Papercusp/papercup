/**
 * curator-card-drill-in — map a curator status card's opaque row `ref` onto the
 * inbox selection id its attention item uses (deterministic-status-cards-2026-07-17
 * P-003/D-004). Pure + unit-testable; the chat (OperatorChat.handleDrillIn) opens
 * the inbox pane (`?opcv=inbox`) and sets the selection (`?opcis=<id>`) from this.
 *
 * The curator's refs come from fleet-signals.ts:
 *   - `escalation:<msgId>` → the inbox attention id `coord-escalation:<msgId>`
 *     (adapters.ts `coordEscalationToAttention`, id `coord-escalation:${msgId}`).
 *   - anything else (`wi:<harness>#<id>`, `plan:<slug>`, a bare id) → no precise
 *     inbox item to select yet; return null so the drill-in just OPENS the inbox
 *     (still better than the old dead monospace). Richer per-ref routing
 *     (work-item / plan surfaces) is a tracked follow-on.
 */

const ESCALATION_PREFIX = 'escalation:';

/**
 * The inbox selection id (`opcis`) for a curator card ref, or null when the ref
 * has no precise inbox item (the caller then just opens the pane).
 */
export function drillInRefToInbox(ref: string): string | null {
  const r = ref.trim();
  if (r.startsWith(ESCALATION_PREFIX)) {
    const msgId = r.slice(ESCALATION_PREFIX.length);
    return msgId ? `coord-escalation:${msgId}` : null;
  }
  return null;
}
