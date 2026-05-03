/**
 * Multi-workspace Operator aggregation (final v5 polish item).
 *
 * Reads `last-scan.json` + `dismissed.json` from every workspace in the
 * registry without switching the active workspace, returning a unified
 * read-only view. The panel surfaces this as an "Other workspaces"
 * section so users see what's pending across all their workspaces
 * without round-tripping through the workspace switcher.
 *
 * Dispatch is NOT enabled cross-workspace — clicking a foreign-workspace
 * card switches to that workspace and reopens the panel there. This
 * keeps RLS + audit + budget scoping coherent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRegistry } from './workspace-registry';

const REGISTRY_ROOT = join(homedir(), '.papercusp-workspaces');

export interface ForeignCard {
  workspaceId: string;
  workspaceName: string;
  card: Record<string, unknown>;
  /** Set when the card has been dismissed (cooldown filter). */
  dismissed: boolean;
}

interface LastScanFile {
  scanCompletedAt?: string;
  cards?: Array<Record<string, unknown> | null | undefined>;
}

interface DismissedFile {
  id: string;
  dismissedAt: string;
}

function workspaceLastScan(workspaceId: string): LastScanFile | null {
  const p = join(REGISTRY_ROOT, workspaceId, '.papercusp', 'system', 'operator', 'last-scan.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LastScanFile;
  } catch {
    return null;
  }
}

function workspaceDismissed(workspaceId: string): Set<string> {
  const p = join(REGISTRY_ROOT, workspaceId, '.papercusp', 'system', 'operator', 'dismissed.json');
  if (!existsSync(p)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(p, 'utf8')) as DismissedFile[];
    return new Set(arr.filter((e) => e && typeof e.id === 'string').map((e) => e.id));
  } catch {
    return new Set();
  }
}

export interface MultiWorkspaceSnapshot {
  /** Sorted by workspace name; cards within a workspace preserve scan order. */
  cards: ForeignCard[];
  /** Per-workspace summary (always present, even when no scan exists). */
  workspaces: { id: string; name: string; cardCount: number; scanCompletedAt: string | null }[];
}

export function readMultiWorkspaceSnapshot(currentWorkspaceId: string): MultiWorkspaceSnapshot {
  const reg = readRegistry();
  const out: MultiWorkspaceSnapshot = { cards: [], workspaces: [] };
  for (const ws of reg.workspaces) {
    if (ws.id === currentWorkspaceId) continue; // current workspace lives in the main view
    const last = workspaceLastScan(ws.id);
    const dismissed = workspaceDismissed(ws.id);
    const cards = (last?.cards ?? []).filter(
      (c): c is Record<string, unknown> => !!c && typeof c === 'object',
    );
    out.workspaces.push({
      id: ws.id,
      name: ws.name,
      cardCount: cards.length,
      scanCompletedAt: last?.scanCompletedAt ?? null,
    });
    for (const card of cards) {
      const id = typeof card.id === 'string' ? card.id : '';
      out.cards.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        card,
        dismissed: id ? dismissed.has(id) : false,
      });
    }
  }
  return out;
}
