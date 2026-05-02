/**
 * Dismissed-suggestion cooldown.
 *
 * Tracks `(id, dismissedAt)` so a suggestion the user explicitly
 * dismissed isn't re-emitted within `cooldownMs` (default 1h).
 *
 * Backed by `harness_shared.operator_dismissed_cards` (migration 015)
 * for multi-machine sync. Falls back to `<papercuspRoot>/system/operator/
 * dismissed.json` when PG is unavailable so the cooldown still works
 * offline / pre-migration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { papercuspPath } from './papercusp-root';
import { withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from './workspace-registry';

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
  // Always write the file for offline/pre-migration safety.
  const entries = readAll().filter((e) => e.id !== id);
  entries.push({ id, dismissedAt: new Date().toISOString() });
  writeAll(entries);
  // Mirror to PG for multi-machine sync — best-effort.
  void mirrorRecordToPg(id).catch(() => {});
}

export function isOnCooldown(id: string, cooldownMs: number = DEFAULT_COOLDOWN_MS): boolean {
  const entry = readAll().find((e) => e.id === id);
  if (!entry) return false;
  return Date.now() - new Date(entry.dismissedAt).getTime() < cooldownMs;
}

export function listDismissed(): DismissedEntry[] {
  return readAll();
}

/**
 * Pull PG-backed dismissed rows into the local file cache. Called from
 * the operator-scan route at the start of each scan so machines stay
 * in sync. Best-effort; no-op when PG isn't reachable.
 */
export async function refreshDismissedFromPg(): Promise<void> {
  try {
    const workspaceId = activeWorkspaceId();
    const rows = await withWorkspace(workspaceId, async (tx) => {
      return tx<{ card_id: string; dismissed_at: string }[]>`
        SELECT card_id, dismissed_at::text
          FROM harness_shared.operator_dismissed_cards
         WHERE dismissed_at > now() - interval '7 days'
      `;
    });
    if (!rows.length) return;
    const local = readAll();
    const localById = new Map(local.map((e) => [e.id, e]));
    for (const r of rows) {
      const ts = r.dismissed_at;
      const cur = localById.get(r.card_id);
      // Take the more recent of (file, pg) per id.
      if (!cur || new Date(cur.dismissedAt).getTime() < new Date(ts).getTime()) {
        localById.set(r.card_id, { id: r.card_id, dismissedAt: new Date(ts).toISOString() });
      }
    }
    writeAll(Array.from(localById.values()));
  } catch {
    /* PG unavailable — file cache stays as-is */
  }
}

async function mirrorRecordToPg(id: string): Promise<void> {
  const workspaceId = activeWorkspaceId();
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.operator_dismissed_cards (workspace_id, card_id, dismissed_at)
      VALUES (${workspaceId}, ${id}, now())
      ON CONFLICT (workspace_id, card_id) DO UPDATE
        SET dismissed_at = EXCLUDED.dismissed_at
    `;
  });
}
