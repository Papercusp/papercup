/**
 * Multi-workspace Operator aggregation (final v5 polish item).
 *
 * Queries `harness_shared.operator_last_scan` + `operator_dismissed_cards`
 * across every workspace in the registry — the active workspace is
 * omitted; it lives in the main panel view.
 *
 * Both tables are PG-canonical since migrations 015 + 020. The previous
 * FS-reading implementation (last-scan.json / dismissed.json) was
 * silently broken: nobody writes those files anymore, so the panel was
 * always returning empty `cards` arrays.
 *
 * Dispatch is NOT enabled cross-workspace — clicking a foreign-workspace
 * card switches to that workspace and reopens the panel there. This
 * keeps RLS + audit + budget scoping coherent.
 */

import { getOrgPg } from '@papercusp/db-org';
import { readRegistry } from './workspace-registry';

export interface ForeignCard {
  workspaceId: string;
  workspaceName: string;
  card: Record<string, unknown>;
  /** Set when the card has been dismissed (cooldown filter). */
  dismissed: boolean;
}

export interface MultiWorkspaceSnapshot {
  /** Sorted by workspace name; cards within a workspace preserve scan order. */
  cards: ForeignCard[];
  /** Per-workspace summary (always present, even when no scan exists). */
  workspaces: { id: string; name: string; cardCount: number; scanCompletedAt: string | null }[];
}

interface LastScanPayload {
  scanCompletedAt?: string;
  cards?: Array<Record<string, unknown> | null | undefined>;
}

export async function readMultiWorkspaceSnapshot(currentWorkspaceId: string): Promise<MultiWorkspaceSnapshot> {
  const reg = readRegistry();
  const out: MultiWorkspaceSnapshot = { cards: [], workspaces: [] };
  const otherIds = reg.workspaces.map((w) => w.id).filter((id) => id !== currentWorkspaceId);
  if (otherIds.length === 0) return out;

  const { sql } = getOrgPg();

  // One round-trip for each table; group results by workspace_id.
  const scans = await sql<{ workspace_id: string; payload: LastScanPayload }[]>`
    SELECT workspace_id, payload
      FROM harness_shared.operator_last_scan
     WHERE workspace_id = ANY(${otherIds}::text[])
  `;
  const dismissed = await sql<{ workspace_id: string; card_id: string }[]>`
    SELECT workspace_id, card_id
      FROM harness_shared.operator_dismissed_cards
     WHERE workspace_id = ANY(${otherIds}::text[])
  `;

  const scanByWs = new Map<string, LastScanPayload>(scans.map((r) => [r.workspace_id, r.payload]));
  const dismissedByWs = new Map<string, Set<string>>();
  for (const d of dismissed) {
    if (!dismissedByWs.has(d.workspace_id)) dismissedByWs.set(d.workspace_id, new Set());
    dismissedByWs.get(d.workspace_id)!.add(d.card_id);
  }

  for (const ws of reg.workspaces) {
    if (ws.id === currentWorkspaceId) continue;
    const scan = scanByWs.get(ws.id);
    const dismissedIds = dismissedByWs.get(ws.id) ?? new Set();
    const cards = (scan?.cards ?? []).filter(
      (c): c is Record<string, unknown> => !!c && typeof c === 'object',
    );
    out.workspaces.push({
      id: ws.id,
      name: ws.name,
      cardCount: cards.length,
      scanCompletedAt: scan?.scanCompletedAt ?? null,
    });
    for (const card of cards) {
      const id = typeof card.id === 'string' ? card.id : '';
      out.cards.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        card,
        dismissed: id ? dismissedIds.has(id) : false,
      });
    }
  }
  return out;
}
