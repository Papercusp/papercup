/**
 * Dismissed-suggestion cooldown (Phase 5).
 *
 * Tracks `(id, dismissedAt)` so a suggestion the user explicitly
 * dismissed isn't re-emitted within `cooldownMs` (default 1h).
 *
 * Stored at `<papercuspRoot>/system/operator/dismissed.json`.
 * v1.5 promotes this to a PG table for multi-machine sync.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { papercuspPath } from './papercusp-root';

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const ENTRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface DismissedEntry {
  id: string;
  dismissedAt: string; // ISO
}

function PATH() {
  return papercuspPath('system', 'operator', 'dismissed.json');
}

function readAll(): DismissedEntry[] {
  if (!existsSync(PATH())) return [];
  try {
    const raw = JSON.parse(readFileSync(PATH(), 'utf8'));
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.id === 'string' && typeof e.dismissedAt === 'string') : [];
  } catch {
    return [];
  }
}

function writeAll(entries: DismissedEntry[]): void {
  const cutoff = Date.now() - ENTRY_RETENTION_MS;
  const trimmed = entries.filter((e) => new Date(e.dismissedAt).getTime() > cutoff);
  mkdirSync(dirname(PATH()), { recursive: true });
  writeFileSync(PATH(), JSON.stringify(trimmed, null, 2));
}

export function recordDismissed(id: string): void {
  const entries = readAll().filter((e) => e.id !== id);
  entries.push({ id, dismissedAt: new Date().toISOString() });
  writeAll(entries);
}

export function isOnCooldown(id: string, cooldownMs: number = DEFAULT_COOLDOWN_MS): boolean {
  const entry = readAll().find((e) => e.id === id);
  if (!entry) return false;
  return Date.now() - new Date(entry.dismissedAt).getTime() < cooldownMs;
}

export function listDismissed(): DismissedEntry[] {
  return readAll();
}
