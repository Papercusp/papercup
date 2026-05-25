'use client';

/**
 * SettingsBanner — Phase 8 P-069b.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 addendum 1 §5.1 — visible in harness settings page, explains who
 * owns the harness's owner-scoped settings.
 *
 * Three modes depending on the harness's claim state + the viewer's
 * relationship to it:
 *
 *   provisional   — "This harness is unclaimed. You're the provisional
 *                   owner." Renders when claim_status='unclaimed' AND
 *                   the viewer is the provisional owner.
 *
 *   unclaimed     — "This harness is unclaimed. @alice is the provisional
 *                   owner." Renders when claim_status='unclaimed' AND
 *                   the viewer is NOT the provisional owner.
 *
 *   claimed       — "Claimed by @alice + N others." Renders when
 *                   claim_status='claimed' regardless of viewer.
 *
 * Pure UI — caller computes which mode to render.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ClaimStatusBadge } from '../_components/ClaimStatusBadge';

const BANNER: CSSProperties = {
  border: '1px solid var(--border, #2a2a2a)',
  background: 'var(--surface-2, #1a1a1a)',
  borderRadius: 8,
  padding: '12px 16px',
  fontSize: 13,
  lineHeight: 1.5,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
};

const TEXT: CSSProperties = {
  flex: 1,
  color: 'var(--fg, #ddd)',
};

const PRIMARY_TEXT: CSSProperties = {
  fontWeight: 600,
  marginBottom: 4,
};

const SUB_TEXT: CSSProperties = {
  color: 'var(--fg-dim, #888)',
  fontSize: 12,
};

export type SettingsBannerMode = 'provisional' | 'unclaimed' | 'claimed';

export interface SettingsBannerProps {
  mode: SettingsBannerMode;
  /** For `unclaimed`/`claimed` — the @login of the relevant person. */
  ownerLogin?: string | null;
  /** For `claimed` — the count of additional claimants beyond the lead. */
  additionalClaimantCount?: number;
}

export function SettingsBanner(props: SettingsBannerProps): ReactNode {
  const { mode, ownerLogin, additionalClaimantCount = 0 } = props;

  let primaryText: ReactNode;
  let subText: ReactNode;

  if (mode === 'provisional') {
    primaryText = (
      <>
        This harness is unclaimed. <strong>You're the provisional owner.</strong>
      </>
    );
    subText =
      'You control owner-scoped settings. A verified GitHub maintainer of the repo can claim this harness, which formalizes ownership.';
  } else if (mode === 'unclaimed') {
    primaryText = (
      <>
        This harness is unclaimed. <strong>@{ownerLogin ?? 'unknown'}</strong>{' '}
        is the provisional owner.
      </>
    );
    subText =
      'They control owner-scoped settings. A verified GitHub maintainer of the repo can claim this harness, which formalizes ownership.';
  } else {
    // claimed
    const moreText =
      additionalClaimantCount > 0
        ? ` + ${additionalClaimantCount} other${
            additionalClaimantCount === 1 ? '' : 's'
          }`
        : '';
    primaryText = (
      <>
        Claimed by <strong>@{ownerLogin ?? 'unknown'}</strong>
        {moreText}.
      </>
    );
    subText =
      'Claimants are repo-authoritative; they control owner-scoped settings.';
  }

  const badgeStatus = mode === 'claimed' ? 'claimed' : 'unclaimed';

  return (
    <div style={BANNER} data-testid="settings-banner" data-mode={mode}>
      <ClaimStatusBadge
        status={badgeStatus}
        claimantLogin={mode === 'claimed' ? ownerLogin : undefined}
      />
      <div style={TEXT}>
        <div style={PRIMARY_TEXT}>{primaryText}</div>
        <div style={SUB_TEXT}>{subText}</div>
      </div>
    </div>
  );
}
