/**
 * Operator idle short-circuit snapshot (Phase 3c of the v5 operator plan).
 *
 * Stored at `<papercuspRoot>/system/operator/idle-snapshot.json`.
 *
 *   {
 *     "fingerprint": "<sha-of-trigger-state>",
 *     "computedAt": "<iso>",
 *     "ttlMs": 1800000,                          // 30 min ceiling
 *     "cards": [...]                             // last scan output
 *   }
 *
 * Background scanner consults this BEFORE spawning the LLM. If the
 * fingerprint matches the current trigger-state digest AND we're inside
 * the 30-min TTL → return the cached cards. Cache invalidates naturally
 * when state changes (different fingerprint); the TTL forces a real
 * scan on stable workspaces every 30 min.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { papercuspPath } from './papercusp-root';

const TTL_MS = 30 * 60 * 1000;

export interface IdleSnapshot {
  fingerprint: string;
  computedAt: string;
  ttlMs: number;
  cards: Record<string, unknown>[];
}

function PATH() {
  return papercuspPath('system', 'operator', 'idle-snapshot.json');
}

export function readSnapshot(): IdleSnapshot | null {
  const p = PATH();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<IdleSnapshot>;
    if (!raw || typeof raw !== 'object' || typeof raw.fingerprint !== 'string') return null;
    return {
      fingerprint: raw.fingerprint,
      computedAt: typeof raw.computedAt === 'string' ? raw.computedAt : new Date(0).toISOString(),
      ttlMs: typeof raw.ttlMs === 'number' ? raw.ttlMs : TTL_MS,
      cards: Array.isArray(raw.cards) ? raw.cards.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object') : [],
    };
  } catch {
    return null;
  }
}

export function writeSnapshot(fingerprint: string, cards: Record<string, unknown>[]): void {
  const p = PATH();
  mkdirSync(dirname(p), { recursive: true });
  const snap: IdleSnapshot = {
    fingerprint,
    computedAt: new Date().toISOString(),
    ttlMs: TTL_MS,
    cards,
  };
  writeFileSync(p, JSON.stringify(snap, null, 2));
}

/**
 * Decide whether the idle snapshot can short-circuit a background scan.
 * Caller computes the current `fingerprint` from trigger state (count of
 * unconsumed pending_events, set of (project_slug, status), inbox row
 * count for system:operator, etc).
 */
export function canShortCircuit(currentFingerprint: string): IdleSnapshot | null {
  const snap = readSnapshot();
  if (!snap) return null;
  if (snap.fingerprint !== currentFingerprint) return null;
  const ageMs = Date.now() - new Date(snap.computedAt).getTime();
  if (ageMs > snap.ttlMs) return null;
  return snap;
}
