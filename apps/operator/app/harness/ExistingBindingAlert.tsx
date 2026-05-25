'use client';

/**
 * ExistingBindingAlert — Phase 8 P-069c.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 addendum 1 §5.1.
 *
 * Fires inside the create-harness / join-existing-harness flow when an
 * existing binding is detected for the GitHub repo the user is about
 * to interact with. Shows the binding's claim status and the canonical
 * owner so the user can decide:
 *
 *   - If the harness is `unclaimed`, the user can join as a contributor
 *     OR (if they have repo-maintainer perms) take the formal claim.
 *
 *   - If the harness is `claimed`, joining means coming in under the
 *     claimant's authority.
 *
 *   - If the harness is `stale` or `superseded`, the alert links to
 *     the relevant resolution flow.
 *
 * Pure UI. The caller computes which CTA(s) to expose via render-prop
 * children.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ClaimStatusBadge, type ClaimStatus } from '../_components/ClaimStatusBadge';

const ALERT: CSSProperties = {
  border: '1px solid var(--border, #2a2a2a)',
  background: 'var(--surface-2, #1a1a1a)',
  borderRadius: 8,
  padding: 16,
  fontSize: 14,
  lineHeight: 1.5,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontWeight: 600,
};

const META: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 13,
  color: 'var(--fg-dim, #888)',
};

const META_ROW: CSSProperties = {
  display: 'flex',
  gap: 8,
};

const META_LABEL: CSSProperties = {
  color: 'var(--fg-dim, #666)',
  minWidth: 90,
};

const META_VALUE: CSSProperties = {
  color: 'var(--fg, #ddd)',
};

const ACTIONS: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 4,
};

export interface ExistingBindingAlertProps {
  /** Slug of the existing harness binding. */
  harnessSlug: string;
  /** GitHub repo, e.g. "octo/repo". */
  githubRepo: string;
  /** Claim state of the existing binding. */
  claimStatus: ClaimStatus;
  /** For `claimed`, the @login of the current claimant. */
  claimantLogin?: string | null;
  /** For `unclaimed`, the @login of the provisional owner. */
  provisionalOwnerLogin?: string | null;
  /** When the binding was first created (display string). */
  createdAtLabel?: string;
  /** Number of verified contributors on the existing binding. */
  contributorCount?: number;
  /** Render-prop slot for CTAs the caller wants to expose (Join /
   * Claim / Open / Migrate). */
  actions?: ReactNode;
}

export function ExistingBindingAlert(
  props: ExistingBindingAlertProps,
): ReactNode {
  const {
    harnessSlug,
    githubRepo,
    claimStatus,
    claimantLogin,
    provisionalOwnerLogin,
    createdAtLabel,
    contributorCount,
    actions,
  } = props;

  let ownerDisplayLabel: string;
  let ownerDisplayValue: string;
  if (claimStatus === 'claimed') {
    ownerDisplayLabel = 'Claimed by';
    ownerDisplayValue = claimantLogin ? `@${claimantLogin}` : '(unknown)';
  } else if (claimStatus === 'unclaimed') {
    ownerDisplayLabel = 'Provisional owner';
    ownerDisplayValue = provisionalOwnerLogin
      ? `@${provisionalOwnerLogin}`
      : '(unknown)';
  } else if (claimStatus === 'stale') {
    ownerDisplayLabel = 'Last claimant';
    ownerDisplayValue = claimantLogin ? `@${claimantLogin}` : '(unknown)';
  } else {
    // superseded
    ownerDisplayLabel = 'Was claimed by';
    ownerDisplayValue = claimantLogin ? `@${claimantLogin}` : '(unknown)';
  }

  return (
    <div
      style={ALERT}
      role="alert"
      data-testid="existing-binding-alert"
      data-claim-status={claimStatus}
    >
      <div style={HEADER}>
        <ClaimStatusBadge
          status={claimStatus}
          claimantLogin={claimantLogin}
        />
        <span>An existing harness already binds this repo.</span>
      </div>

      <div style={META}>
        <div style={META_ROW}>
          <span style={META_LABEL}>Harness</span>
          <span style={META_VALUE}>
            <code>{harnessSlug}</code>
          </span>
        </div>
        <div style={META_ROW}>
          <span style={META_LABEL}>GitHub repo</span>
          <span style={META_VALUE}>
            <code>{githubRepo}</code>
          </span>
        </div>
        <div style={META_ROW}>
          <span style={META_LABEL}>{ownerDisplayLabel}</span>
          <span style={META_VALUE}>{ownerDisplayValue}</span>
        </div>
        {createdAtLabel ? (
          <div style={META_ROW}>
            <span style={META_LABEL}>Created</span>
            <span style={META_VALUE}>{createdAtLabel}</span>
          </div>
        ) : null}
        {typeof contributorCount === 'number' ? (
          <div style={META_ROW}>
            <span style={META_LABEL}>Contributors</span>
            <span style={META_VALUE}>{contributorCount}</span>
          </div>
        ) : null}
      </div>

      {actions ? <div style={ACTIONS}>{actions}</div> : null}
    </div>
  );
}
