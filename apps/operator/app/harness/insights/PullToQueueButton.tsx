'use client';

/**
 * PullToQueueButton — Phase 5b P-032a.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 * v5 §9.1 — per-row "Pull into my queue" / "Remove from my queue".
 *
 * Pure UI. Consumer passes `queued` state + `onToggle` callback. The
 * client wrapper (PullToQueueButtonClient) does the optimistic-update
 * + POST plumbing.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface PullToQueueButtonProps {
  /** Whether the feature is currently in this user's queue. */
  queued: boolean;
  /** Click handler. */
  onToggle?: () => void;
  /** Disable while a write is in flight. */
  pending?: boolean;
  /** Hide when this user is not a contributor / not authenticated. */
  hidden?: boolean;
  /** Width override; defaults to fit-content. */
  width?: number | string;
}

function styleFor(queued: boolean, pending: boolean): CSSProperties {
  const base: CSSProperties = {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid var(--border, #2a2a2a)',
    cursor: pending ? 'progress' : 'pointer',
    opacity: pending ? 0.6 : 1,
    background: queued ? 'var(--surface-2, #2a2a2a)' : 'transparent',
    color: queued ? 'var(--fg, #ddd)' : 'var(--fg-dim, #aaa)',
    fontWeight: queued ? 600 : 400,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };
  return base;
}

export function PullToQueueButton(props: PullToQueueButtonProps): ReactNode {
  if (props.hidden) return null;
  const queued = props.queued;
  const pending = !!props.pending;
  const label = queued ? 'In my queue' : 'Pull into my queue';
  return (
    <button
      type="button"
      data-testid="pull-to-queue-btn"
      data-queued={queued ? '1' : '0'}
      aria-pressed={queued}
      disabled={pending}
      onClick={props.onToggle}
      style={{ ...styleFor(queued, pending), width: props.width }}
      title={queued ? 'Click to remove from your queue' : 'Click to add to your queue'}
    >
      {label}
    </button>
  );
}
