// @vitest-environment jsdom
/**
 * MarketplaceList.test.tsx — whole-app-coverage P-008.
 *
 * The catalog grid. Covers the real branches: kind filtering, the card title
 * link, the uncontrolled search query filter, both empty states (no-match vs
 * nothing-published), and the installed badge + local-install count.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarketplaceList, type CatalogEntry } from './MarketplaceList';

afterEach(cleanup);

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    slug: 'alpha',
    name: 'Alpha',
    version: '1.0.0',
    description: 'first template',
    author: 'alice',
    license: 'MIT',
    plugins: [],
    kind: 'template',
    ...over,
  };
}

describe('MarketplaceList', () => {
  it('renders template cards with a title link to the detail route', () => {
    render(<MarketplaceList kind="template" catalog={[entry()]} />);
    expect(screen.getByRole('link', { name: 'Alpha' }).getAttribute('href')).toBe('/marketplace/alpha');
    expect(screen.getByText('first template')).toBeTruthy();
  });

  it('filters the catalog to the requested kind', () => {
    render(
      <MarketplaceList
        kind="template"
        catalog={[entry(), entry({ slug: 'plug', name: 'PlugOne', kind: 'plugin' })]}
      />,
    );
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('PlugOne')).toBeNull();
    expect(screen.getByText(/1 of 1 templates/)).toBeTruthy();
  });

  it('filters by the search query (uncontrolled)', () => {
    render(
      <MarketplaceList
        kind="template"
        catalog={[entry(), entry({ slug: 'beta', name: 'Beta', description: 'second' })]}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Search templates/), { target: { value: 'beta' } });
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('shows the no-match empty state', () => {
    render(<MarketplaceList kind="template" catalog={[entry()]} />);
    fireEvent.change(screen.getByPlaceholderText(/Search templates/), { target: { value: 'zzz' } });
    expect(screen.getByText(/No templates match/)).toBeTruthy();
  });

  it('shows the nothing-published empty state for an empty catalog', () => {
    render(<MarketplaceList kind="template" catalog={[]} />);
    expect(screen.getByText(/No templates published yet/)).toBeTruthy();
  });

  it('marks installed templates and counts them locally', () => {
    render(
      <MarketplaceList
        kind="template"
        catalog={[entry()]}
        installedTemplates={[{ slug: 'alpha', version: '1.0.0', description: null }]}
      />,
    );
    expect(screen.getByText('Installed')).toBeTruthy();
    expect(screen.getByText(/1 installed locally/)).toBeTruthy();
  });
});
