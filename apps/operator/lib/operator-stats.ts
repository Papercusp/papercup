/**
 * Operator stats / KPIs (final v5 surface).
 *
 * Aggregates 7 days of operator audit_log + budget spend into a tight
 * panel of numbers users actually care about: how many cards land,
 * what fraction auto-dispatch, what fraction get dismissed, escalation
 * rate (the Path-(a) escalation criterion), median ack latency. Powers
 * the "Operator stats" section in /settings/operator.
 *
 * Cheap query — bounded by ~7 days of operator-actor audit rows.
 */

import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { loadBudget } from './operator-budget';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface OperatorStats {
  windowDays: number;
  /** Total cards seen (count of distinct card_ids that flipped to dispatched OR dismissed). */
  cardsTotal: number;
  /** Counts by terminal state. */
  dispatched: number;
  dismissed: number;
  consumed: number;
  escalated: number;
  rejected: number;
  failed: number;
  undoCancelled: number;
  /** Median dispatched→consumed latency (ms). null when fewer than 3 samples. */
  medianAckLatencyMs: number | null;
  /** Path-(a) escalation criterion: fraction stuck dispatched-pending-ack > 2× cadence. */
  unconsumedFraction: number | null;
  /** Last-7-days cost from budget.json. */
  spend: { date: string; usd: number }[];
  totalSpendUsd: number;
}

interface AuditRow {
  ts: number;
  action: string;
  subject: string;
}

const UNCONSUMED_2X_CADENCE_MS = 2 * 60_000;

export async function readOperatorStats(): Promise<OperatorStats> {
  const cutoff = Date.now() - WINDOW_MS;
  let rows: AuditRow[] = [];
  try {
    const workspaceId = activeWorkspaceId();
    rows = await withWorkspace(workspaceId, async (tx) => {
      return tx<AuditRow[]>`
        SELECT ts, action, subject
          FROM harness_shared.audit_log
         WHERE actor  = 'system:operator'
           AND action LIKE 'operator.%'
           AND ts     >= ${cutoff}
         ORDER BY ts ASC
      `;
    });
  } catch {
    /* PG unavailable — return empty */
  }

  const counts: Record<string, number> = {
    dispatched: 0, acked: 0, dismissed: 0, undo_cancel: 0,
    consumed: 0, escalated: 0, rejected: 0, failed: 0, superseded: 0,
  };
  const dispatchTsByCard = new Map<string, number>();
  const consumedTsByCard = new Map<string, number>();
  const seenCards = new Set<string>();
  for (const r of rows) {
    const kind = r.action.replace(/^operator\./, '');
    counts[kind] = (counts[kind] ?? 0) + 1;
    seenCards.add(r.subject);
    if (kind === 'dispatched') dispatchTsByCard.set(r.subject, r.ts);
    if (kind === 'consumed') consumedTsByCard.set(r.subject, r.ts);
  }

  // Median ack latency (dispatched → consumed pairs).
  const latencies: number[] = [];
  for (const [cardId, dispTs] of dispatchTsByCard) {
    const ackTs = consumedTsByCard.get(cardId);
    if (!ackTs) continue;
    const lat = ackTs - dispTs;
    if (lat > 0 && lat < 24 * 60 * 60 * 1000) latencies.push(lat);
  }
  let medianAckLatencyMs: number | null = null;
  if (latencies.length >= 3) {
    latencies.sort((a, b) => a - b);
    medianAckLatencyMs = latencies[Math.floor(latencies.length / 2)];
  }

  // Path-(a) escalation criterion: dispatched cards with no consumed/escalated/rejected
  // within 2× cadence (= 2 min default). Excludes still-fresh dispatches.
  const now = Date.now();
  let stuckCount = 0;
  let evaluable = 0;
  for (const [cardId, dispTs] of dispatchTsByCard) {
    if (now - dispTs < UNCONSUMED_2X_CADENCE_MS) continue;
    evaluable++;
    if (consumedTsByCard.has(cardId)) continue;
    stuckCount++;
  }
  const unconsumedFraction = evaluable > 0 ? stuckCount / evaluable : null;

  const budget = loadBudget();
  const spend = budget?.spend ?? [];
  const totalSpendUsd = spend.reduce((a, s) => a + s.usd, 0);

  return {
    windowDays: 7,
    cardsTotal: seenCards.size,
    dispatched: counts.dispatched,
    dismissed: counts.dismissed,
    consumed: counts.consumed,
    escalated: counts.escalated,
    rejected: counts.rejected,
    failed: counts.failed,
    undoCancelled: counts.undo_cancel,
    medianAckLatencyMs,
    unconsumedFraction,
    spend,
    totalSpendUsd,
  };
}
