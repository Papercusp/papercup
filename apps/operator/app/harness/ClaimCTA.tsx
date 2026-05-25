'use client';

/**
 * ClaimCTA — Phase 8 P-069e.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 addendum 1 §5.1.
 *
 * Renders the "Claim this harness" button shown to the viewer when the
 * harness's binding is `unclaimed` AND the viewer wishes to formalize
 * ownership. Wraps the click into the structured-error contract from
 * Phase 1b P-068 `claimBinding`:
 *
 *   onClaim: () => Promise<BindingRecord>
 *     // throws BindingServiceErrorThrowable on permission denial, etc.
 *
 * UI obligations:
 *   - disable + spinner while in-flight
 *   - on success: call onSuccess (caller can refetch / close modal)
 *   - on `CLAIM_PERMISSION_DENIED`: explainer ("You need maintain/admin
 *     on the repo to claim; your role is `<actual>`.") with link to the
 *     GitHub repo settings
 *   - on `BINDING_NOT_CLAIMABLE`: explainer reading the reason string
 *   - on `BINDING_NOT_FOUND`: explainer (rare — binding evicted underfoot)
 *   - on GH-API errors: generic-but-not-confusing message with retry
 *
 * Pure UI — `claimBinding` is passed in via `onClaim` so this component
 * is trivially testable without PG.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  BindingServiceErrorThrowable,
  type BindingRecord,
  type BindingServiceError,
} from '../../lib/harness/binding-types';

const PRIMARY_BUTTON: CSSProperties = {
  background: 'var(--accent, #4CAF50)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '10px 18px',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

const DISABLED_BUTTON: CSSProperties = {
  ...PRIMARY_BUTTON,
  background: 'var(--surface-2, #2a2a2a)',
  color: 'var(--fg-dim, #888)',
  cursor: 'not-allowed',
};

const ERROR_BOX: CSSProperties = {
  marginTop: 12,
  padding: 12,
  borderRadius: 6,
  background: 'var(--bg-warning, rgba(255, 152, 0, 0.12))',
  border: '1px solid var(--fg-warning, #FF9800)',
  color: 'var(--fg, #ddd)',
  fontSize: 13,
  lineHeight: 1.5,
};

const ERROR_LINK: CSSProperties = {
  color: 'var(--accent, #4CAF50)',
  textDecoration: 'underline',
};

export interface ClaimCTAProps {
  /** Binding id to claim. */
  bindingId: string;
  /** GitHub `owner/repo`, used in the permission-denied link. */
  githubRepo: string;
  /** Click handler. Must call `claimBinding({ binding_id: bindingId })`
   * and either resolve with the updated `BindingRecord` or throw a
   * `BindingServiceErrorThrowable`. */
  onClaim: () => Promise<BindingRecord>;
  /** Called after a successful claim. Caller refetches / closes UI. */
  onSuccess?: (binding: BindingRecord) => void;
  /** Optional override label. */
  label?: string;
}

interface CtaErrorState {
  primary: string;
  retry: boolean;
  helpHref?: string;
  helpLabel?: string;
}

function mapErrorToCopy(
  error: BindingServiceError,
  githubRepo: string,
): CtaErrorState {
  switch (error.code) {
    case 'CLAIM_PERMISSION_DENIED':
      return {
        primary: `You need ${error.required} on this repo to claim it. Your current role is "${error.actual}".`,
        retry: false,
        helpHref: `https://github.com/${githubRepo}/settings/access`,
        helpLabel: 'Open repo access settings',
      };
    case 'BINDING_NOT_CLAIMABLE':
      return {
        primary: `This binding can't be claimed: ${error.reason}.`,
        retry: false,
      };
    case 'BINDING_NOT_FOUND':
      return {
        primary: 'This binding no longer exists. Refresh and try again.',
        retry: true,
      };
    case 'GITHUB_REPO_NOT_FOUND':
      return {
        primary: 'The bound GitHub repo could not be found.',
        retry: false,
      };
    case 'GITHUB_REPO_PRIVATE_NO_ACCESS':
      return {
        primary: 'You do not have access to the bound GitHub repo.',
        retry: false,
      };
    case 'GITHUB_API_RATE_LIMIT':
      return {
        primary: `GitHub rate-limited the request. Try again in ${Math.ceil(
          error.retry_after_ms / 1000,
        )}s.`,
        retry: true,
      };
    case 'GITHUB_API_DOWN':
      return {
        primary: 'GitHub is unreachable right now. Try again in a moment.',
        retry: true,
      };
    case 'BINDING_EXISTS':
      // Should not happen on claim path — guard anyway.
      return {
        primary: 'Unexpected: this binding already exists in another state.',
        retry: false,
      };
    case 'SUPERSEDE_PERMISSION_DENIED':
      // Wrong endpoint — guard.
      return {
        primary: 'Unexpected permission error for this action.',
        retry: false,
      };
  }
}

export function ClaimCTA(props: ClaimCTAProps): ReactNode {
  const { bindingId, githubRepo, onClaim, onSuccess, label } = props;
  const [pending, setPending] = useState(false);
  const [errorState, setErrorState] = useState<CtaErrorState | null>(null);

  async function handleClick(): Promise<void> {
    setPending(true);
    setErrorState(null);
    try {
      const updated = await onClaim();
      onSuccess?.(updated);
    } catch (e) {
      if (e instanceof BindingServiceErrorThrowable) {
        setErrorState(mapErrorToCopy(e.error, githubRepo));
      } else {
        setErrorState({
          primary: `Claim failed: ${
            (e as Error)?.message ?? 'unknown error'
          }`,
          retry: true,
        });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="claim-cta" data-binding-id={bindingId}>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        style={pending ? DISABLED_BUTTON : PRIMARY_BUTTON}
        data-testid="claim-cta-button"
      >
        {pending ? 'Claiming…' : (label ?? 'Claim this harness')}
      </button>

      {errorState ? (
        <div role="alert" style={ERROR_BOX} data-testid="claim-cta-error">
          <div>{errorState.primary}</div>
          {errorState.helpHref ? (
            <div style={{ marginTop: 6 }}>
              <a
                href={errorState.helpHref}
                target="_blank"
                rel="noreferrer"
                style={ERROR_LINK}
                data-testid="claim-cta-help-link"
              >
                {errorState.helpLabel ?? errorState.helpHref}
              </a>
            </div>
          ) : null}
          {errorState.retry ? (
            <div style={{ marginTop: 6, color: 'var(--fg-dim, #888)' }}>
              You can try again.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
