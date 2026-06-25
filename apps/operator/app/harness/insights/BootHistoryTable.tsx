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

// Keep in sync with the canonical union in
// `lib/sync/hyperbee/boot-history.ts`. The KIND_COLOR / KIND_MARK maps below
// must stay exhaustive over every kind.
export type BootHistoryKind =
  | 'boot_start'
  | 'boot_ok'
  | 'boot_fail'
  | 'close'
  | 'peer_connected'
  | 'swarm_join_failed'
  | 'peer_rejected'
  | 'peer_rate_limited'
  | 'peer_capped'
  | 'peer_revoked'
  | 'announce_admitted'
  | 'announce_pending'
  | 'announce_rejected'
  | 'announce_error'
  | 'merge_error'
  | 'rekey_grant_failed'
  | 'rekey_grant_skipped'
  | 'rekey_boundary_skipped'
  | 'epoch_gate_built'
  | 'epoch_defer'
  | 'epoch_decrypt_fail'
  | 'epoch_applied';

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

const KIND_COLOR: Record<BootHistoryKind, string> = {
  boot_start: 'var(--fg-dim)',
  boot_ok: 'var(--good)',
  boot_fail: 'var(--bad)',
  close: 'var(--fg-dim)',
  peer_connected: 'var(--accent)',
  swarm_join_failed: 'var(--warn)',
  peer_rejected: 'var(--warn)',
  peer_rate_limited: 'var(--bad)',
  peer_capped: 'var(--warn)',
  peer_revoked: 'var(--bad)',
  announce_admitted: 'var(--good)',
  announce_pending: 'var(--warn)',
  announce_rejected: 'var(--warn)',
  announce_error: 'var(--bad)',
  merge_error: 'var(--bad)',
  rekey_grant_failed: 'var(--bad)',
  rekey_grant_skipped: 'var(--warn)',
  rekey_boundary_skipped: 'var(--warn)',
  epoch_gate_built: 'var(--accent)',
  epoch_defer: 'var(--warn)',
  epoch_decrypt_fail: 'var(--bad)',
  epoch_applied: 'var(--good)',
};

const KIND_MARK: Record<BootHistoryKind, string> = {
  boot_start: '·',
  boot_ok: '✓',
  boot_fail: '✗',
  close: '×',
  peer_connected: '⇄',
  swarm_join_failed: '⚠',
  peer_rejected: '⛔',
  peer_rate_limited: '🛑',
  peer_capped: '✂',
  peer_revoked: '🚫',
  announce_admitted: '➕',
  announce_pending: '⏳',
  announce_rejected: '⛔',
  announce_error: '✗',
  merge_error: '✗',
  rekey_grant_failed: '✗',
  rekey_grant_skipped: '⤼',
  rekey_boundary_skipped: '⤳',
  epoch_gate_built: '🔐',
  epoch_defer: '⏸',
  epoch_decrypt_fail: '🔓',
  epoch_applied: '✓',
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
      render: ({ row }) => <span style={{ color: KIND_COLOR[row.kind], whiteSpace: 'nowrap' }}>{KIND_MARK[row.kind]} {row.kind}</span>,
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
