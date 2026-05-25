'use client';

/**
 * ClobberToast — Phase 5b P-035.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 * v5 D-012 — when a remote LWW-write overrides a recent local write,
 * the substrate emits a `clobber` event (`lib/sync/hyperbee/clobber-events`).
 * This component renders the user-facing toast for one such event,
 * including the inline diff panel + per-event dismiss.
 *
 * Copy guard rail (per phase plan Q-2): toast says "was overridden",
 * not "was rejected by" — the clobber detection is reliable; the
 * *interpretation* "they overrode me intentionally" is not.
 *
 * Pure UI. Consumer supplies the clobber payload + dismiss callback.
 * The client wrapper that owns subscription + state is a follow-up
 * (depends on the SSE/HTTP surface that emits clobber events to the
 * browser).
 */

import { useState, type CSSProperties, type ReactNode } from 'react';

export interface ClobberToastEvent {
  /** Stable id (for keying multiple toasts). */
  id: string;
  /** Hyperbee table tag, e.g. "queue", "contributors". */
  table: string;
  /** Composite key within the table. Display verbatim. */
  hbKey: string;
  /** Human-friendly field that changed (defaults to the table tag). */
  field?: string;
  /** Display name (or login) of the contributor whose write took precedence. */
  byContributor: string;
  /** My local write JSON. */
  myValue?: unknown;
  /** Their remote write JSON that overrode it. */
  theirValue?: unknown;
  /** Epoch ms when the override was observed. */
  observedAt: number;
}

export interface ClobberToastProps {
  event: ClobberToastEvent;
  onDismiss: (id: string) => void;
}

const WRAP: CSSProperties = {
  border: '1px solid var(--border, #2a2a2a)',
  background: 'var(--surface, #1a1a1a)',
  borderRadius: 8,
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontSize: 13,
  color: 'var(--fg, #ddd)',
  maxWidth: 480,
};

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const TITLE: CSSProperties = {
  fontWeight: 500,
  lineHeight: 1.4,
};

const DISMISS_BTN: CSSProperties = {
  background: 'transparent',
  color: 'var(--fg-dim, #888)',
  border: 'none',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 4,
};

const VIEW_BTN: CSSProperties = {
  alignSelf: 'flex-start',
  background: 'transparent',
  color: 'var(--accent, #6aa)',
  border: 'none',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
  textDecoration: 'underline',
};

const DIFF_PANEL: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
  marginTop: 6,
  fontSize: 11,
};

const DIFF_COL: CSSProperties = {
  background: 'var(--surface-2, #2a2a2a)',
  borderRadius: 4,
  padding: 8,
  overflowX: 'auto',
};

const DIFF_LABEL: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  color: 'var(--fg-dim, #888)',
  marginBottom: 4,
  letterSpacing: 0.4,
};

function fmt(value: unknown): string {
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ClobberToast(props: ClobberToastProps): ReactNode {
  const ev = props.event;
  const [open, setOpen] = useState(false);
  const field = ev.field ?? ev.table;
  return (
    <div role="status" data-testid={`clobber-toast-${ev.id}`} style={WRAP}>
      <div style={HEADER}>
        <span style={TITLE}>
          Your change to <code>{field}</code> on <code>{ev.hbKey}</code> was overridden by{' '}
          <strong>{ev.byContributor}</strong>.
        </span>
        <button
          type="button"
          aria-label="Dismiss"
          data-testid={`clobber-dismiss-${ev.id}`}
          style={DISMISS_BTN}
          onClick={() => props.onDismiss(ev.id)}
        >
          ×
        </button>
      </div>
      <button
        type="button"
        aria-expanded={open}
        data-testid={`clobber-view-diff-${ev.id}`}
        style={VIEW_BTN}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide diff' : 'View diff'}
      </button>
      {open && (
        <div data-testid={`clobber-diff-${ev.id}`} style={DIFF_PANEL}>
          <div style={DIFF_COL}>
            <div style={DIFF_LABEL}>You wrote</div>
            <pre style={{ margin: 0 }}>{fmt(ev.myValue)}</pre>
          </div>
          <div style={DIFF_COL}>
            <div style={DIFF_LABEL}>{ev.byContributor} wrote</div>
            <pre style={{ margin: 0 }}>{fmt(ev.theirValue)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
