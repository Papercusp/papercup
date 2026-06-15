// @vitest-environment jsdom
/**
 * MarketplaceIndex.test.tsx — whole-app-coverage P-008.
 *
 * The marketplace overview. Verifies the three category cards + hrefs, the
 * search form target, and the optional per-kind counts (shown when provided,
 * gracefully omitted when not — the static-export case).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarketplaceIndex } from './MarketplaceIndex';

afterEach(cleanup);

describe('MarketplaceIndex', () => {
  it('renders the three category cards with their hrefs', () => {
    render(<MarketplaceIndex />);
    expect(screen.getByRole('link', { name: /Templates/ }).getAttribute('href')).toBe('/marketplace/templates');
    expect(screen.getByRole('link', { name: /Plugins/ }).getAttribute('href')).toBe('/marketplace/plugins');
    expect(screen.getByRole('link', { name: /Snapshots/ }).getAttribute('href')).toBe('/marketplace/snapshots');
  });

  it('omits counts when none are provided (graceful static-export degrade)', () => {
    render(<MarketplaceIndex />);
    expect(screen.queryByText(/available/)).toBeNull();
  });

  it('shows per-category counts when provided', () => {
    render(<MarketplaceIndex counts={{ templates: 3, plugins: 1 }} />);
    expect(screen.getByText(/3 available/)).toBeTruthy();
    expect(screen.getByText(/1 available/)).toBeTruthy();
  });

  it('exposes a search form targeting the templates listing', () => {
    render(<MarketplaceIndex />);
    expect(screen.getByRole('search').getAttribute('action')).toBe('/marketplace/templates');
  });
});
