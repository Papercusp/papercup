/**
 * Operator-card actions invoked from the mobile WS bridge.
 *
 * Runs in-process (same Node as Next), so we skip HTTP and call the
 * underlying libs directly. Dispatch goes through /api/admin/execute-action
 * because that's where action-id validation + audit live; we sign with the
 * operator's own bearer (same approach the operator-dispatch route uses).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { papercuspPath } from './papercusp-root';
import { readSystemPrincipal } from './system-principal';
import { notifySyncInvalidate } from './sync-sse';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { readLastScan } from './operator-last-scan';
import { reconstructCards } from './operator-card-reconstruction';
import { recordDismissed } from './operator-dismissed-cache';

interface OperatorBearer {
  bearer: string;
  workspaceId: string;
}

async function loadOperatorBearer(): Promise<OperatorBearer | null> {
  const p = await readSystemPrincipal('operator');
  return p ? { bearer: p.bearer, workspaceId: p.workspaceId } : null;
}

function seedToUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface PendingCard {
  id: string;
  action: string;
  reason?: string;
  target_harness?: string;
  directive_kind?: string;
  directive_subject?: string;
  directive_body?: string;
  status: string;
}

/** Most-recent pending operator suggestions, in display order (1-indexed for ordinals). */
export async function listPendingCards(): Promise<PendingCard[]> {
  const reconstructed = await reconstructCards();
  const cards = reconstructed
    .filter((c) => c.status === 'pending' || c.status === 'shown')
    .map((c) => ({
      id: typeof c.payload.id === 'string' ? c.payload.id : '',
      action: typeof c.payload.action === 'string' ? c.payload.action : 'unknown',
      reason: c.payload.reason as string | undefined,
      target_harness: c.payload.target_harness as string | undefined,
      directive_kind: c.payload.directive_kind as string | undefined,
      directive_subject: c.payload.directive_subject as string | undefined,
      directive_body: c.payload.directive_body as string | undefined,
      status: c.status,
    }))
    .filter((c) => c.id.length > 0);

  if (cards.length > 0) return cards;

  // Fallback to the raw last-scan snapshot if reconstruction couldn't find
  // the audit-log lifecycle events (e.g. fresh process). Same shape.
  const last = await readLastScan();
  if (!last?.cards) return [];
  return last.cards
    .filter((c: any) => typeof c.id === 'string')
    .map((c: any) => ({
      id: c.id,
      action: c.action ?? 'unknown',
      reason: c.reason,
      target_harness: c.target_harness,
      directive_kind: c.directive_kind,
      directive_subject: c.directive_subject,
      directive_body: c.directive_body,
      status: 'pending',
    }));
}

/**
 * Dispatch a pending card. Goes through /api/admin/execute-action with the
 * operator bearer (same code path operator-dispatch uses). Returns a short
 * human description of the outcome for TTS readback.
 */
export async function dispatchCard(card: PendingCard): Promise<string> {
  if (card.action !== 'send_directive' || !card.target_harness) {
    return `${card.action} cards are advisory; nothing to dispatch.`;
  }
  const principal = await loadOperatorBearer();
  if (!principal) return 'Papercup is not provisioned. Run provision first.';

  const actionId = seedToUuid(`${card.id}:dispatch`);
  const body = {
    actionId,
    action: {
      op: 'send_message',
      to: [card.target_harness],
      kind: card.directive_kind ?? 'Directive',
      subject: card.directive_subject ?? '',
      body: card.directive_body ?? '',
      reason: card.reason ?? '',
    },
  };

  const base = process.env.PAPERCUSP_OPERATOR_BASE ?? `http://localhost:${process.env.PORT ?? 3055}`;
  const res = await fetch(`${base}/api/admin/execute-action`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${principal.bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return `Dispatch failed (HTTP ${res.status}): ${text.slice(0, 120)}`;
  }
  return `Dispatched to ${card.target_harness}.`;
}

export async function dismissCard(card: PendingCard): Promise<string> {
  await recordDismissed(card.id);
  return `Dismissed: ${describeCard(card)}.`;
}

export function describeCard(card: PendingCard): string {
  if (card.directive_subject) return card.directive_subject;
  if (card.target_harness) return `${card.action} → ${card.target_harness}`;
  return card.action;
}

// ── Pause / resume sentinel (PG-backed, migration 029) ─────────────────
//
// Was previously `<ws>/.papercusp/system/operator/paused.flag` — file
// existence = "paused". Now `harness_shared.operator_paused` row with
// JSONB payload `{ paused, by?, at? }`. We keep `paused: false` rows
// rather than deleting on resume so the row holds the audit trail of
// the last-pause-by-whom (read by getPauseInfo when paused, ignored
// otherwise). Same single-row-per-workspace pattern as the rest of
// operator-state-pg.

interface PauseState {
  paused: boolean;
  by?: string;
  at?: string;
}

export async function setPaused(by: string): Promise<void> {
  await writeOperatorState<PauseState>('operator_paused', {
    paused: true,
    by,
    at: new Date().toISOString(),
  });
  void notifySyncInvalidate('operatorPauseFlag').catch(() => {});
}

export async function setResumed(): Promise<void> {
  await writeOperatorState<PauseState>('operator_paused', { paused: false });
  void notifySyncInvalidate('operatorPauseFlag').catch(() => {});
}

export async function isPaused(): Promise<boolean> {
  const s = await readOperatorState<PauseState>('operator_paused');
  return s?.paused === true;
}

export async function getPauseInfo(): Promise<{ paused: boolean; by?: string; at?: string }> {
  const s = await readOperatorState<PauseState>('operator_paused');
  if (!s?.paused) return { paused: false };
  return { paused: true, by: s.by, at: s.at };
}
