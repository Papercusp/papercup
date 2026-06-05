'use client';

/**
 * SpendCard — Phase 8 P-073f.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 Insights tab — spend tile, tier-D (viewer-only).
 *
 * Renders:
 *   - Total spend for the harness this week (LOCAL tool_invocations).
 *   - Viewer's share-of-harness rough number (their fraction of total).
 *   - Banner with proxy-witness deferral text from v5 addendum-2:
 *     "Spend is computed locally on your machine; proxy-witness
 *      aggregation is deferred until <link>."
 *
 * The whole card is tier-D — never visible to other contributors.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { SpendCardProps } from '@papercusp/operator-core/lib/harness-insights/card-types';

const CARD: CSSProperties = {
  border: '1px solid var(--border, #2a2a2a)',
  background: 'var(--surface, #1a1a1a)',
  borderRadius: 10,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontSize: 14,
};

const TITLE_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const TITLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--fg, #ddd)',
};

const TIER_PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 10,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 6,
  border: '1px solid var(--fg-dim, #888)',
  color: 'var(--fg-dim, #888)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const STATS: CSSProperties = {
  display: 'flex',
  gap: 20,
};

const STAT_VAL: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  color: 'var(--fg, #ddd)',
};

const STAT_LABEL: CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-dim, #888)',
  marginTop: 2,
};

const SHARE_BAR_WRAP: CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--surface-2, #2a2a2a)',
  overflow: 'hidden',
  marginTop: 4,
};

const SHARE_BAR_FILL: CSSProperties = {
  height: '100%',
  background: 'var(--accent, #4CAF50)',
};

const BANNER: CSSProperties = {
  fontSize: 12,
  padding: '8px 12px',
  borderRadius: 6,
  background: 'var(--surface-2, #2a2a2a)',
  color: 'var(--fg-dim, #aaa)',
  lineHeight: 1.5,
};

const BANNER_LINK: CSSProperties = {
  color: 'var(--accent, #4CAF50)',
  textDecoration: 'none',
};

export type { SpendCardProps };

function formatUsd(n: number): string {
  return n < 1
    ? `$${n.toFixed(2)}`
    : n < 100
      ? `$${n.toFixed(1)}`
      : `$${Math.round(n)}`;
}

export function SpendCard(props: SpendCardProps): ReactNode {
  const {
    harnessTotalUsdThisWeek,
    viewerUsdThisWeek,
    proxyWitnessExplainerHref,
  } = props;

  const sharePct =
    harnessTotalUsdThisWeek > 0
      ? Math.min(100, (viewerUsdThisWeek / harnessTotalUsdThisWeek) * 100)
      : 0;

  return (
    <div style={CARD} data-testid="insights-spend-card">
      <div style={TITLE_ROW}>
        <div style={TITLE}>Spend</div>
        <span style={TIER_PILL} data-testid="spend-card-tier-pill">
          ⏱ Tier D
        </span>
      </div>

      <div style={STATS}>
        <div data-testid="spend-card-harness-total">
          <div style={STAT_VAL}>
            {formatUsd(harnessTotalUsdThisWeek)}
          </div>
          <div style={STAT_LABEL}>Harness, this week</div>
        </div>
        <div style={{ flex: 1 }} data-testid="spend-card-viewer-share">
          <div style={STAT_VAL}>{formatUsd(viewerUsdThisWeek)}</div>
          <div style={STAT_LABEL}>You, this week ({sharePct.toFixed(0)}%)</div>
          <div style={SHARE_BAR_WRAP}>
            <div
              style={{ ...SHARE_BAR_FILL, width: `${sharePct}%` }}
              data-testid="spend-card-share-bar-fill"
            />
          </div>
        </div>
      </div>

      <div style={BANNER} data-testid="spend-card-banner">
        Spend is computed locally on your machine. Proxy-witness
        aggregation across contributors is deferred until later —{' '}
        {proxyWitnessExplainerHref ? (
          <a
            href={proxyWitnessExplainerHref}
            style={BANNER_LINK}
            data-testid="spend-card-banner-link"
          >
            see plan.
          </a>
        ) : (
          'see plan.'
        )}
      </div>
    </div>
  );
}
