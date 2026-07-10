'use client';

/**
 * BootHistoryTable — Phase 5a diagnostic table.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Compact table rendering boot-history entries. One row per event;
 * 4 columns (time / workspace + slug / kind / message). Color-coded
 * per kind. Empty state when no events.
 *
 * Pure UI; consumer feeds the `entries` field from
 * /api/admin/dogfood-substrate-boot-history.
 */

import type { CSSProperties, ReactNode } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { BOOT_HISTORY_KIND_COLOR, BOOT_HISTORY_KIND_FALLBACK } from '../theme';

// Keep in sync with the canonical union in
// `lib/sync/hyperbee/boot-history.ts`. The KIND_MARK map below must stay
// exhaustive over every kind; kind hues live centrally in harness/theme.ts
// (BOOT_HISTORY_KIND_COLOR — the status-map lint's one home for these).
export type BootHistoryKind =
  | 'boot_start'
  | 'boot_ok'
  | 'boot_fail'
  | 'close'
  | 'peer_connected'
  // WI-1910 hardening: join-lifecycle witnesses (started at joinForBinding
  // entry; succeeded after the swarm join returns; the failure side is the
  // existing 'swarm_join_failed'). started-without-either-outcome = a wedged
  // join — the silent state the WI-1910 hunt could not distinguish.
  | 'join_started'
  | 'join_succeeded'
  | 'swarm_join_failed'
  | 'peer_rejected'
  | 'peer_rate_limited'
  // P-008 (harden-shared-hive-to-256-peers): drive-by fix while syncing
  // 'replication_stalled' below — this kind existed in the canonical union
  // (boot-history.ts) but was missing here, a pre-existing exhaustiveness
  // drift (harmless: an unmapped kind renders with no color/mark, not a crash).
  | 'peer_cap_near'
  | 'peer_capped'
  | 'peer_revoked'
  | 'peer_unrevoked'
  | 'replication_stalled'
  // P-004 (WI-1840): attached-but-dead replication — was in the canonical
  // union but missing here (same exhaustiveness drift as peer_cap_near above).
  | 'replication_frozen'
  | 'announce_admitted'
  | 'announce_pending'
  | 'announce_rejected'
  // WI-1662: recorded alongside 'announce_rejected' when the reason is specifically
  // clock skew (>5min stale_ts) rather than a bad/forged signature.
  | 'announce_clock_skew'
  | 'announce_error'
  | 'merge_error'
  | 'rekey_grant_failed'
  | 'rekey_grant_skipped'
  | 'rekey_boundary_skipped'
  | 'epoch_gate_built'
  | 'epoch_gate_seen'
  | 'epoch_defer'
  | 'epoch_decrypt_fail'
  | 'epoch_applied'
  // WI-3604 (split-DHT-universe recurrence guard): recorded once per harness
  // join, right after this process's shared swarm resolves its DHT
  // bootstrap. See boot-history.ts for the full incident rationale.
  | 'dht_universe_ok'
  | 'dht_universe_mismatch';

export interface BootHistoryEntry {
  ts: number;
  workspaceId: string;
  harnessSlug: string;
  kind: BootHistoryKind;
  message?: string;
}

export interface BootHistoryTableProps {
  entries: ReadonlyArray<BootHistoryEntry>;
  /** Optional: override now-millis used for relative-time labels (test). */
  nowMs?: number;
}

const KIND_MARK: Record<BootHistoryKind, string> = {
  boot_start: '·',
  boot_ok: '✓',
  boot_fail: '✗',
  close: '×',
  peer_connected: '⇄',
  join_started: '▶',
  join_succeeded: '🔗',
  swarm_join_failed: '⚠',
  peer_rejected: '⛔',
  peer_rate_limited: '🛑',
  peer_cap_near: '📶',
  peer_capped: '✂',
  peer_revoked: '🚫',
  peer_unrevoked: '↩',
  replication_stalled: '🧊',
  replication_frozen: '❄',
  announce_admitted: '➕',
  announce_pending: '⏳',
  announce_rejected: '⛔',
  announce_clock_skew: '🕒',
  announce_error: '✗',
  merge_error: '✗',
  rekey_grant_failed: '✗',
  rekey_grant_skipped: '⤼',
  rekey_boundary_skipped: '⤳',
  epoch_gate_built: '🔐',
  epoch_gate_seen: '👁',
  epoch_defer: '⏸',
  epoch_decrypt_fail: '🔓',
  epoch_applied: '✓',
  dht_universe_ok: '🌐',
  dht_universe_mismatch: '🌐⚠',
};

const EMPTY: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim)',
  padding: '12px 0',
};

function relTime(ts: number, now: number): string {
  const ageMs = now - ts;
  if (ageMs < 0) return 'just now';
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function columns(now: number): ColumnDef<BootHistoryEntry>[] {
  return [
    {
      key: 'when',
      header: 'When',
      width: 0.85,
      toCopyText: (e) => `${relTime(e.ts, now)} ago`,
      render: ({ row }) => `${relTime(row.ts, now)} ago`,
    },
    {
      key: 'workspace',
      header: 'Workspace',
      width: 1.4,
      toCopyText: (e) => e.workspaceId,
      render: ({ row }) => <code>{row.workspaceId}</code>,
    },
    {
      key: 'harness',
      header: 'Harness',
      width: 1.4,
      toCopyText: (e) => e.harnessSlug,
      render: ({ row }) => <code>{row.harnessSlug}</code>,
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.4,
      toCopyText: (e) => e.kind,
      render: ({ row }) => <span style={{ color: BOOT_HISTORY_KIND_COLOR[row.kind] ?? BOOT_HISTORY_KIND_FALLBACK, whiteSpace: 'nowrap' }}>{KIND_MARK[row.kind]} {row.kind}</span>,
    },
    {
      key: 'message',
      header: 'Message',
      width: 2.4,
      toCopyText: (e) => e.message ?? '',
      render: ({ row }) => <span style={{ color: 'var(--fg-dim)' }}>{row.message ?? ''}</span>,
    },
  ];
}

export function BootHistoryTable(props: BootHistoryTableProps): ReactNode {
  const { entries } = props;
  const now = props.nowMs ?? Date.now();
  if (entries.length === 0) {
    return (
      <div style={EMPTY} data-testid="boot-history-empty">
        No substrate boot events yet.
      </div>
    );
  }
  return (
    <div style={{ height: Math.min(520, 32 + entries.length * 30 + 4) }} data-testid="boot-history-table">
      <RichGrid<BootHistoryEntry>
        columns={columns(now)}
        rows={[...entries]}
        getRowId={(e, i) => `${e.ts}-${e.workspaceId}-${e.harnessSlug}-${e.kind}-${i}`}
        rowMinHeight={30}
        headerHeight={32}
        rowProps={({ row }) => ({ 'data-testid': `boot-history-row-${row.kind}` })}
      />
    </div>
  );
}
