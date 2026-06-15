// @vitest-environment jsdom
/**
 * MarketplaceLayout.test.tsx — whole-app-coverage P-008.
 *
 * The marketplace tab frame. Verifies all four section tabs render, children
 * pass through, and the active-tab derivation (Overview is exact-match on the
 * root; the others match by pathname prefix).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarketplaceLayout } from './MarketplaceLayout';

afterEach(cleanup);

describe('MarketplaceLayout', () => {
  it('renders every section tab and its children', () => {
    render(
      <MarketplaceLayout pathname="/marketplace">
        <p>child-content</p>
      </MarketplaceLayout>,
    );
    expect(screen.getByRole('tab', { name: /Overview/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Templates/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Plugins/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Snapshots/ })).toBeTruthy();
    expect(screen.getByText('child-content')).toBeTruthy();
  });

  it('marks Overview active on the marketplace root path only', () => {
    render(<MarketplaceLayout pathname="/marketplace"><span /></MarketplaceLayout>);
    expect(screen.getByRole('tab', { name: /Overview/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Templates/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('marks a sub-section active by pathname prefix', () => {
    render(<MarketplaceLayout pathname="/marketplace/templates/foo"><span /></MarketplaceLayout>);
    expect(screen.getByRole('tab', { name: /Templates/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Overview/ }).getAttribute('aria-selected')).toBe('false');
  });
});
