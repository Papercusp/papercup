// @vitest-environment jsdom
/**
 * InstalledPacksSection.test.tsx — the per-pot installed-packs overview on the
 * Cupboard Knowledge Packs tab (cupboard-public-release-2026-07-12 P-016). It
 * lists the selected pot's pack rollups and deep-links each to its listing
 * detail page (where management lives). useSyncQuery is mocked and switched on
 * queryName (learning.hiveList + learning.hive).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';

let syncData: Record<string, unknown[]>;
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string }) => ({
    data: syncData[opts.queryName] ?? [],
    error: null,
    fetching: false,
    loading: false,
    invalidate: vi.fn(),
  }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import InstalledPacksSection from './InstalledPacksSection';

// EI-1539: these must stay TWO DISTINCT packs — the multi-row test below asserts
// two rows, resolves a title per row, and puts the muted badge on one and the
// update badge on the other. The second slot used to be the retired
// `papercusp-default`; it is now `work`, the other real shipped builtin pack.
// Do not collapse both onto `coding` — that yields a duplicate React key and an
// ambiguous getByText.
const listings = [
  { id: 'listing-coding', listing_ref: 'coding', title: 'Generic Coding Learnings' },
  { id: 'listing-work', listing_ref: 'work', title: 'Generic Work Learnings' },
] as unknown as HarnessListing[];

beforeEach(() => {
  syncData = { 'learning.hiveList': [], 'learning.hive': [] };
});
afterEach(cleanup);

describe('<InstalledPacksSection /> (P-016)', () => {
  it('renders nothing when there are no pots', () => {
    const { container } = render(<InstalledPacksSection listings={listings} onOpen={vi.fn()} />);
    expect(container.querySelector('[data-testid="cupboard-installed-packs"]')).toBeNull();
  });

  it('shows an empty state when the pot has no installed packs', () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    syncData['learning.hive'] = [{ hive: 'coding', packs: [] }];
    render(<InstalledPacksSection listings={listings} onOpen={vi.fn()} />);
    expect(screen.getByTestId('cupboard-installed-packs')).toBeTruthy();
    expect(screen.getByText(/No knowledge packs installed/i)).toBeTruthy();
  });

  it('lists installed packs (with listing title) and deep-links each to its detail page', () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    syncData['learning.hive'] = [
      {
        hive: 'coding',
        packs: [
          { packId: 'coding', present: 3, packTotal: 4, modified: 0, notPresent: 1, enabled: true, updateAvailable: true, availableVersion: '2.0.0' },
          { packId: 'work', present: 5, packTotal: 5, modified: 0, notPresent: 0, enabled: false },
        ],
      },
    ];
    const onOpen = vi.fn();
    render(<InstalledPacksSection listings={listings} onOpen={onOpen} />);
    const rows = screen.getAllByTestId('cupboard-installed-pack-row');
    expect(rows).toHaveLength(2);
    // Titles resolve from the matched listings; the muted + update badges show.
    expect(screen.getByText('Generic Coding Learnings')).toBeTruthy();
    expect(screen.getByText('Generic Work Learnings')).toBeTruthy();
    expect(screen.getByText(/muted/i)).toBeTruthy();
    expect(screen.getByText(/update v2\.0\.0/i)).toBeTruthy();
    // Clicking the coding row navigates to its listing detail id.
    fireEvent.click(screen.getByText('Generic Coding Learnings'));
    expect(onOpen).toHaveBeenCalledWith('listing-coding');
  });

  it('renders a pack with no Cupboard listing as a non-clickable row', () => {
    syncData['learning.hiveList'] = [{ slug: 'coding', remote: false }];
    syncData['learning.hive'] = [
      { hive: 'coding', packs: [{ packId: 'fleet-lessons', present: 2, packTotal: 2, modified: 0, notPresent: 0, enabled: true }] },
    ];
    const onOpen = vi.fn();
    render(<InstalledPacksSection listings={listings} onOpen={onOpen} />);
    const row = screen.getByTestId('cupboard-installed-pack-row');
    expect(row.tagName).toBe('DIV'); // not a button
    expect(screen.getByText('fleet-lessons')).toBeTruthy();
    fireEvent.click(row);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
