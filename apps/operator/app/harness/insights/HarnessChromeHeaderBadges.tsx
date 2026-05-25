'use client';

/**
 * HarnessChromeHeaderBadges — chrome-header drop-in composer.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23.
 *
 * Bundles the dogfood badges that belong in the harness chrome header
 * into a single component so the existing chrome only needs one
 * import. Each child component is independent and self-fetching, so
 * adding/removing them here doesn't ripple through the chrome.
 *
 * Currently includes:
 *   - SubstrateStatusBadgeClient (per-harness substrate flag/booted state)
 *   - BootstrapProgressIndicatorClient (live merge progress, P-066)
 *
 * Easy to extend with more badges (ClaimAttemptStatsPill, ContributorBadgeRow
 * sized for chrome, ClaimStatusBadge from binding cache, etc.) as
 * they become useful in the header.
 *
 * Pure UI composition; nothing to test beyond rendering each child.
 */

import type { CSSProperties, ReactNode } from 'react';
import { SubstrateStatusBadgeClient } from './SubstrateStatusBadgeClient';
import { BootstrapProgressIndicatorClient } from './BootstrapProgressIndicatorClient';
import { SubstrateHealthPillClient } from './SubstrateHealthPillClient';
import { ClaimAttemptStatsPillClient } from './ClaimAttemptStatsPillClient';

const ROW: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

export interface HarnessChromeHeaderBadgesProps {
  slug: string;
  /** Hide the substrate-status pill. Default false. */
  hideSubstrateBadge?: boolean;
  /** Hide the bootstrap-progress pill. Default false. */
  hideBootstrapProgress?: boolean;
  /** Hide the substrate-health verdict pill. Default false. */
  hideHealthPill?: boolean;
  /** Hide the claim-attempt stats pill. Default true (debug-only by default). */
  hideClaimStats?: boolean;
}

export function HarnessChromeHeaderBadges(
  props: HarnessChromeHeaderBadgesProps,
): ReactNode {
  const {
    slug,
    hideSubstrateBadge,
    hideBootstrapProgress,
    hideHealthPill,
    hideClaimStats = true,
  } = props;
  return (
    <span style={ROW} data-testid="harness-chrome-header-badges">
      {!hideSubstrateBadge && <SubstrateStatusBadgeClient slug={slug} />}
      {!hideHealthPill && <SubstrateHealthPillClient slug={slug} />}
      {!hideBootstrapProgress && (
        <BootstrapProgressIndicatorClient slug={slug} />
      )}
      {!hideClaimStats && <ClaimAttemptStatsPillClient slug={slug} compact />}
    </span>
  );
}
