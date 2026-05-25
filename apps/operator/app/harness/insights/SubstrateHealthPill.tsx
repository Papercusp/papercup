'use client';

/**
 * SubstrateHealthPill — Phase 5a diagnostic.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Compact pill for one (workspace, harness) health verdict from
 * assessHarnessSubstrateHealth. Five states:
 *
 *   disabled / booting / healthy / degraded / unhealthy
 *
 * Each renders with distinct colour + dot + tooltip listing reasons.
 *
 * Pure UI; consumer fetches /api/admin/dogfood-substrate-health and
 * passes per-row verdicts.
 */

import type { CSSProperties, ReactNode } from 'react';

export type SubstrateHealthVerdict =
  | 'disabled'
  | 'booting'
  | 'healthy'
  | 'degraded'
  | 'unhealthy';

export interface SubstrateHealthPillProps {
  verdict: SubstrateHealthVerdict;
  reasons?: ReadonlyArray<string>;
}

const PILL_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 12,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  borderWidth: 1,
  borderStyle: 'solid',
};

const DOT: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 3,
};

interface Style {
  label: string;
  background: string;
  color: string;
  borderColor: string;
}

const STYLES: Record<SubstrateHealthVerdict, Style> = {
  disabled: {
    label: 'Disabled',
    background: 'var(--surface-2, #2a2a2a)',
    color: 'var(--fg-dim, #888)',
    borderColor: 'var(--border, #2a2a2a)',
  },
  booting: {
    label: 'Booting',
    background: 'var(--bg-warning, rgba(255, 152, 0, 0.12))',
    color: 'var(--fg-warning, #FF9800)',
    borderColor: 'var(--fg-warning, #FF9800)',
  },
  healthy: {
    label: 'Healthy',
    background: 'var(--accent-soft, rgba(76, 175, 80, 0.15))',
    color: 'var(--accent, #4CAF50)',
    borderColor: 'var(--accent, #4CAF50)',
  },
  degraded: {
    label: 'Degraded',
    background: 'var(--bg-warning, rgba(255, 152, 0, 0.18))',
    color: 'var(--fg-warning, #FF9800)',
    borderColor: 'var(--fg-warning, #FF9800)',
  },
  unhealthy: {
    label: 'Unhealthy',
    background: 'var(--bg-danger, rgba(244, 67, 54, 0.15))',
    color: 'var(--fg-danger, #f44336)',
    borderColor: 'var(--fg-danger, #f44336)',
  },
};

export function SubstrateHealthPill(
  props: SubstrateHealthPillProps,
): ReactNode {
  const { verdict, reasons } = props;
  const s = STYLES[verdict];
  const title = reasons && reasons.length > 0 ? reasons.join(' · ') : s.label;
  return (
    <span
      style={{
        ...PILL_BASE,
        background: s.background,
        color: s.color,
        borderColor: s.borderColor,
      }}
      data-testid="substrate-health-pill"
      data-verdict={verdict}
      title={title}
    >
      <span style={{ ...DOT, background: s.color }} />
      {s.label}
    </span>
  );
}
