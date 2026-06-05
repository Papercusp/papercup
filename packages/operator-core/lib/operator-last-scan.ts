/**
 * Operator last-scan persistence (Phase 1b of the v5 operator plan).
 *
 * Persisted in `harness_shared.operator_last_scan` (PG, migration 020).
 * Was previously `<papercuspRoot>/system/operator/last-scan.json`. PG
 * gives multi-tab safe reads + cross-machine sync; fixes the multi-tab
 * clobber where two open operator tabs each ran a scan and the second
 * wiped the first's stored cards.
 *
 * Full reconstruction (merging `executed_actions` for already-dispatched
 * cards + dismissed-localStorage) is layered on top of this in the panel —
 * this module only persists the scan output.
 */

import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { notifySyncInvalidate } from './sync-sse';

export interface LastScanEntry {
  /** ISO timestamp of when the scan completed. */
  scanCompletedAt: string;
  /** Cost of the scan that produced these cards (USD). */
  scanCostUsd: number;
  /** Enriched suggestions, exactly as the panel received via SSE `suggestion` events. */
  cards: Record<string, unknown>[];
}

export async function writeLastScan(entry: LastScanEntry): Promise<void> {
  await writeOperatorState('operator_last_scan', entry);
  void notifySyncInvalidate('operatorLastScan').catch(() => {});
}

export async function readLastScan(): Promise<LastScanEntry | null> {
  const raw = await readOperatorState<Partial<LastScanEntry>>('operator_last_scan');
  if (!raw || !Array.isArray(raw.cards)) return null;
  return {
    scanCompletedAt: typeof raw.scanCompletedAt === 'string' ? raw.scanCompletedAt : new Date(0).toISOString(),
    scanCostUsd: typeof raw.scanCostUsd === 'number' ? raw.scanCostUsd : 0,
    cards: raw.cards.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object'),
  };
}
