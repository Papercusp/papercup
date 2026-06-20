// @vitest-environment jsdom
/**
 * pi.test.tsx — /pi PiTerminalsDock route. Covers validateSearch (string-only
 * harness/lane guards), the missing-?harness hint, and the harness path that
 * lazy-loads PiTerminalsDock (mocked) with the slug + initial lane.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route with controllable
 * useSearch), @/app/harness/PiTerminalsDock stubbed so React.lazy resolves it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let searchVal: { harness?: string; lane?: string };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useSearch: () => searchVal }),
}));
vi.mock('@/app/harness/PiTerminalsDock', () => ({
  default: ({ slug, initialLaneId }: { slug: string; initialLaneId?: string }) => (
    <div data-testid="pi-dock" data-slug={slug} data-lane={initialLaneId ?? ''} />
  ),
}));

import { Route } from './pi';

const validateSearch = (Route as { validateSearch: (s: Record<string, unknown>) => { harness?: string; lane?: string } }).validateSearch;
const Comp = Route.component as () => JSX.Element;

afterEach(cleanup);

describe('/pi validateSearch', () => {
  it('keeps string harness + lane', () => {
    expect(validateSearch({ harness: 'sheets', lane: 'l1' })).toEqual({ harness: 'sheets', lane: 'l1' });
  });
  it('maps non-string values to undefined', () => {
    expect(validateSearch({ harness: 5, lane: {} })).toEqual({ harness: undefined, lane: undefined });
    expect(validateSearch({})).toEqual({ harness: undefined, lane: undefined });
  });
});

describe('/pi component', () => {
  it('shows the missing-harness hint when no ?harness is set', () => {
    searchVal = {};
    render(<Comp />);
    expect(screen.getByText(/Missing/)).toBeTruthy();
    expect(screen.queryByTestId('pi-dock')).toBeNull();
  });

  it('lazy-renders the terminals dock with slug + lane when ?harness is set', async () => {
    searchVal = { harness: 'sheets', lane: 'lane-2' };
    render(<Comp />);
    const dock = await screen.findByTestId('pi-dock');
    expect(dock.getAttribute('data-slug')).toBe('sheets');
    expect(dock.getAttribute('data-lane')).toBe('lane-2');
  });
});
