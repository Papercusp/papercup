/**
 * Operator idle short-circuit snapshot (Phase 3c of the v5 operator plan).
 *
 * Persisted in `harness_shared.operator_idle_snapshot` (PG, migration 020).
 * Was previously `<papercuspRoot>/system/operator/idle-snapshot.json`. PG
 * fixes the multi-tab race the file approach had (two tabs both writing
 * idle snapshots could lose the more recent one).
 *
 * Background scanner consults this BEFORE spawning the LLM. If the
 * fingerprint matches the current trigger-state digest AND we're inside
 * the 30-min TTL → return the cached cards. Cache invalidates naturally
 * when state changes (different fingerprint); the TTL forces a real
 * scan on stable workspaces every 30 min.
 */

import { readOperatorState, writeOperatorState } from './operator-state-pg';

const TTL_MS = 30 * 60 * 1000;

export interface IdleSnapshotHarnessLine {
  slug: string;
  status: string;
  lastTouched: string | null;
}

export interface IdleSnapshot {
  fingerprint: string;
  computedAt: string;
  ttlMs: number;
  cards: Record<string, unknown>[];
  /**
   * Per-harness one-liner status (Phase 5 polish). Surfaced alongside the
   * cached cards on idle short-circuit so the user sees current per-harness
   * state even when nothing changed since the last real scan. Excluded
   * from the fingerprint (cosmetic).
   */
  perHarness?: IdleSnapshotHarnessLine[];
}

export async function readSnapshot(): Promise<IdleSnapshot | null> {
  const raw = await readOperatorState<Partial<IdleSnapshot>>('operator_idle_snapshot');
  if (!raw || typeof raw.fingerprint !== 'string') return null;
  return {
    fingerprint: raw.fingerprint,
    computedAt: typeof raw.computedAt === 'string' ? raw.computedAt : new Date(0).toISOString(),
    ttlMs: typeof raw.ttlMs === 'number' ? raw.ttlMs : TTL_MS,
    cards: Array.isArray(raw.cards) ? raw.cards.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object') : [],
    perHarness: Array.isArray(raw.perHarness)
      ? raw.perHarness
          .filter((h): h is IdleSnapshotHarnessLine =>
            !!h && typeof h === 'object'
            && typeof (h as IdleSnapshotHarnessLine).slug === 'string'
            && typeof (h as IdleSnapshotHarnessLine).status === 'string')
      : undefined,
  };
}

export async function writeSnapshot(
  fingerprint: string,
  cards: Record<string, unknown>[],
  perHarness?: IdleSnapshotHarnessLine[],
): Promise<void> {
  const snap: IdleSnapshot = {
    fingerprint,
    computedAt: new Date().toISOString(),
    ttlMs: TTL_MS,
    cards,
    ...(perHarness !== undefined ? { perHarness } : {}),
  };
  await writeOperatorState('operator_idle_snapshot', snap);
}

/**
 * Decide whether the idle snapshot can short-circuit a background scan.
 * Caller computes the current `fingerprint` from trigger state (count of
 * unconsumed pending_events, set of (project_slug, status), inbox row
 * count for system:operator, etc).
 */
export async function canShortCircuit(currentFingerprint: string): Promise<IdleSnapshot | null> {
  const snap = await readSnapshot();
  if (!snap) return null;
  if (snap.fingerprint !== currentFingerprint) return null;
  const ageMs = Date.now() - new Date(snap.computedAt).getTime();
  if (ageMs > snap.ttlMs) return null;
  return snap;
}
