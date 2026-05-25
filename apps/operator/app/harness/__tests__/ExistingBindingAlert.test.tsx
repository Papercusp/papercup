/**
 * @vitest-environment jsdom
 *
 * ExistingBindingAlert — P-069c tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ExistingBindingAlert } from '../ExistingBindingAlert';

afterEach(() => {
  cleanup();
});

describe('ExistingBindingAlert — P-069c', () => {
  it('claimed binding labels the claimant', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="claimed"
        claimantLogin="alice"
      />,
    );
    const alert = screen.getByTestId('existing-binding-alert');
    expect(alert.getAttribute('data-claim-status')).toBe('claimed');
    expect(alert.textContent).toContain('Claimed by');
    expect(alert.textContent).toContain('@alice');
    expect(alert.textContent).toContain('papercup');
    expect(alert.textContent).toContain('papercupai/papercup');
  });

  it('unclaimed binding labels the provisional owner', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="unclaimed"
        provisionalOwnerLogin="bob"
      />,
    );
    const alert = screen.getByTestId('existing-binding-alert');
    expect(alert.getAttribute('data-claim-status')).toBe('unclaimed');
    expect(alert.textContent).toContain('Provisional owner');
    expect(alert.textContent).toContain('@bob');
  });

  it('stale binding labels the last claimant', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="stale"
        claimantLogin="carol"
      />,
    );
    const alert = screen.getByTestId('existing-binding-alert');
    expect(alert.getAttribute('data-claim-status')).toBe('stale');
    expect(alert.textContent).toContain('Last claimant');
    expect(alert.textContent).toContain('@carol');
  });

  it('superseded binding labels prior claimant', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="superseded"
        claimantLogin="dave"
      />,
    );
    const alert = screen.getByTestId('existing-binding-alert');
    expect(alert.getAttribute('data-claim-status')).toBe('superseded');
    expect(alert.textContent).toContain('Was claimed by');
    expect(alert.textContent).toContain('@dave');
  });

  it('omits createdAt and contributorCount when not provided', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="unclaimed"
        provisionalOwnerLogin="bob"
      />,
    );
    const alert = screen.getByTestId('existing-binding-alert');
    expect(alert.textContent).not.toContain('Created');
    expect(alert.textContent).not.toContain('Contributors');
  });

  it('shows createdAt and contributorCount when provided', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="claimed"
        claimantLogin="alice"
        createdAtLabel="3 days ago"
        contributorCount={7}
      />,
    );
    const alert = screen.getByTestId('existing-binding-alert');
    expect(alert.textContent).toContain('Created');
    expect(alert.textContent).toContain('3 days ago');
    expect(alert.textContent).toContain('Contributors');
    expect(alert.textContent).toContain('7');
  });

  it('renders actions render-prop when provided', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="unclaimed"
        provisionalOwnerLogin="bob"
        actions={
          <>
            <button data-testid="action-join">Join as contributor</button>
            <button data-testid="action-claim">Claim</button>
          </>
        }
      />,
    );
    expect(screen.getByTestId('action-join')).toBeTruthy();
    expect(screen.getByTestId('action-claim')).toBeTruthy();
  });

  it('uses role=alert for screen readers', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="unclaimed"
        provisionalOwnerLogin="bob"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-testid')).toBe('existing-binding-alert');
  });

  it('falls back to (unknown) when login is missing', () => {
    render(
      <ExistingBindingAlert
        harnessSlug="papercup"
        githubRepo="papercupai/papercup"
        claimStatus="unclaimed"
      />,
    );
    const alert = screen.getByTestId('existing-binding-alert');
    expect(alert.textContent).toContain('(unknown)');
  });
});
