/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { HarnessClaimHeader } from '../HarnessClaimHeader';

afterEach(() => cleanup());

describe('HarnessClaimHeader — P-069b', () => {
  it('renders title as plain text when no href', () => {
    render(<HarnessClaimHeader title="Sheets" status="unclaimed" />);
    expect(screen.getByText('Sheets')).toBeTruthy();
    expect(screen.queryByTestId('harness-claim-header-title-link')).toBeNull();
  });

  it('renders title as link when href provided', () => {
    render(<HarnessClaimHeader title="Sheets" href="/harness/sheets" status="unclaimed" />);
    const link = screen.getByTestId('harness-claim-header-title-link');
    expect(link.getAttribute('href')).toBe('/harness/sheets');
    expect(link.textContent).toBe('Sheets');
  });

  it('unclaimed: explainer shows + claim CTA HIDDEN without viewerCanClaim', () => {
    render(<HarnessClaimHeader title="T" status="unclaimed" />);
    expect(screen.getByTestId('harness-claim-explainer')).toBeTruthy();
    expect(screen.queryByTestId('harness-claim-cta')).toBeNull();
  });

  it('unclaimed + viewerCanClaim: claim CTA renders + fires onClaimClick', () => {
    const onClaimClick = vi.fn();
    render(
      <HarnessClaimHeader title="T" status="unclaimed" viewerCanClaim onClaimClick={onClaimClick} />,
    );
    const cta = screen.getByTestId('harness-claim-cta');
    fireEvent.click(cta);
    expect(onClaimClick).toHaveBeenCalledTimes(1);
  });

  it('claimed: CTA hidden even with viewerCanClaim (no double-claim path)', () => {
    render(<HarnessClaimHeader title="T" status="claimed" claimantLogin="alice" viewerCanClaim />);
    expect(screen.queryByTestId('harness-claim-cta')).toBeNull();
    // ClaimStatusBadge surfaces the claimant.
    expect(screen.getByText(/@alice/)).toBeTruthy();
  });

  it('stale: shows stale explainer; CTA only when viewerCanClaim AND unclaimed', () => {
    render(<HarnessClaimHeader title="T" status="stale" viewerCanClaim />);
    expect(screen.getByTestId('harness-claim-stale-explainer')).toBeTruthy();
    expect(screen.queryByTestId('harness-claim-cta')).toBeNull();
  });

  it('superseded: passes href through to ClaimStatusBadge', () => {
    render(<HarnessClaimHeader title="T" status="superseded" supersededByHref="/harness/successor" />);
    expect(screen.getByTestId('claim-status-superseded-link').getAttribute('href')).toBe('/harness/successor');
  });

  it('does NOT show the unclaimed explainer when status is not unclaimed', () => {
    render(<HarnessClaimHeader title="T" status="claimed" claimantLogin="x" />);
    expect(screen.queryByTestId('harness-claim-explainer')).toBeNull();
  });
});
