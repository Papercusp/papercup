/**
 * Operator last-scan persistence (Phase 1b of the v5 operator plan).
 *
 * Every successful scan writes a snapshot of the suggestions it produced
 * to `<papercuspRoot>/system/operator/last-scan.json` so reopening the
 * panel reconstructs the cards instead of starting blank.
 *
 * Full reconstruction (merging `executed_actions` for already-dispatched
 * cards + dismissed-localStorage) is layered on top of this in the panel —
 * this module only persists the scan output.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { papercuspPath } from './papercusp-root';

export interface LastScanEntry {
  /** ISO timestamp of when the scan completed. */
  scanCompletedAt: string;
  /** Cost of the scan that produced these cards (USD). */
  scanCostUsd: number;
  /** Enriched suggestions, exactly as the panel received via SSE `suggestion` events. */
  cards: Record<string, unknown>[];
}

function PATH() {
  return papercuspPath('system', 'operator', 'last-scan.json');
}

export function writeLastScan(entry: LastScanEntry): void {
  const p = PATH();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(entry, null, 2));
}

export function readLastScan(): LastScanEntry | null {
  const p = PATH();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<LastScanEntry>;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cards)) return null;
    return {
      scanCompletedAt: typeof raw.scanCompletedAt === 'string' ? raw.scanCompletedAt : new Date(0).toISOString(),
      scanCostUsd: typeof raw.scanCostUsd === 'number' ? raw.scanCostUsd : 0,
      cards: raw.cards.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object'),
    };
  } catch {
    return null;
  }
}
