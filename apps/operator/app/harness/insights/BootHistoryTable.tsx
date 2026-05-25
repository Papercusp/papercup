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

export type BootHistoryKind =
  | 'boot_start'
  | 'boot_ok'
  | 'boot_fail'
  | 'close';

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
  boot_start: 'var(--fg-dim, #888)',
  boot_ok: 'var(--accent, #4CAF50)',
  boot_fail: 'var(--fg-danger, #f44336)',
  close: 'var(--fg-dim, #888)',
};

const KIND_MARK: Record<BootHistoryKind, string> = {
  boot_start: '·',
  boot_ok: '✓',
  boot_fail: '✗',
  close: '×',
};

const TABLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};

const TH: CSSProperties = {
  textAlign: 'left',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  padding: '6px 10px',
  fontWeight: 600,
  color: 'var(--fg-dim, #888)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const TD: CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border-subtle, #222)',
  verticalAlign: 'top',
};

const KIND_CELL: CSSProperties = {
  ...TD,
  whiteSpace: 'nowrap',
};

const EMPTY: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim, #888)',
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
    <table style={TABLE} data-testid="boot-history-table">
      <thead>
        <tr>
          <th style={TH}>When</th>
          <th style={TH}>Workspace</th>
          <th style={TH}>Harness</th>
          <th style={TH}>Kind</th>
          <th style={TH}>Message</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr
            key={`${e.ts}-${e.workspaceId}-${e.harnessSlug}-${e.kind}-${i}`}
            data-testid={`boot-history-row-${e.kind}`}
          >
            <td style={TD}>{relTime(e.ts, now)} ago</td>
            <td style={TD}>
              <code>{e.workspaceId}</code>
            </td>
            <td style={TD}>
              <code>{e.harnessSlug}</code>
            </td>
            <td style={{ ...KIND_CELL, color: KIND_COLOR[e.kind] }}>
              {KIND_MARK[e.kind]} {e.kind}
            </td>
            <td style={{ ...TD, color: 'var(--fg-dim, #aaa)' }}>
              {e.message ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
