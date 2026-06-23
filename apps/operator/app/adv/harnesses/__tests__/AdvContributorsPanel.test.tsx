/**
 * @vitest-environment jsdom
 *
 * AdvContributorsPanel — P-048 render test. Verifies the live-shell Contributors
 * panel actually renders rows (binding badges, tier pills, joined, devices, the
 * "you" marker) and applies the P-048d unverified-zeroing — the thing the live
 * Tauri pass couldn't confirm (the panel is dock-only; this is the deterministic
 * equivalent). Mocks fetch (/contributors + /api/viewer), nuqs, and useViewer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const syncState = vi.hoisted(() => ({
  contributors: [] as unknown[],
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: queryName === 'contributors.byHarness' ? syncState.contributors : null,
    loading: false,
    error: null,
    fetching: false,
    invalidate: vi.fn(),
  }),
}));

// nuqs: useQueryState → a plain useState seeded with the parser default.
vi.mock('nuqs', () => ({
  useQueryState: (_key: string, opts?: { defaultValue?: unknown }) => {
    const [v, setV] = React.useState(opts?.defaultValue ?? null);
    return [v, async (x: unknown) => setV(x)];
  },
  parseAsStringEnum: () => ({ withDefault: (d: unknown) => ({ defaultValue: d }) }),
  // cusage uses parseAsInteger directly (nullable, no default) → seeds null.
  parseAsInteger: {},
}));

// viewer: alice (42) is "me".
vi.mock('../useViewer', () => ({
  useViewer: () => ({ viewer: { githubUserId: 42, githubLogin: 'alice' }, loading: false, isMe: (id: number) => id === 42 }),
}));

import AdvContributorsPanel from '../AdvContributorsPanel';

const api = { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
const props = { panelId: 'p', panelType: 'adv:contributors', params: { harnessSlug: 'h' }, api } as never;

const CONTRIBUTORS = [
  // verified — full tiers shown
  { github_user_id: 42, github_username: 'alice', display_name: 'Alice', avatar_url: null, joined_at: 1700000000000, binding_status: 'verified', device_count: 2, prs_merged: 3, features_shipped: 4, activity_events: 5 },
  // unverified — the endpoint/panel must ZERO these (even though the mock sends 9s)
  { github_user_id: 7, github_username: 'bob', display_name: null, avatar_url: null, joined_at: 1, binding_status: 'unverified', device_count: 0, prs_merged: 9, features_shipped: 9, activity_events: 9 },
];

beforeEach(() => {
  syncState.contributors = CONTRIBUTORS;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/contributor-usage')) {
      return new Response(
        JSON.stringify({
          rollup: {
            github_user_id: 42,
            harness_slug: 'h',
            counts: {
              feature_authored: 3,
              feature_queued: 0,
              feature_worked_start: 0,
              feature_worked_end: 0,
              pr_opened: 0,
              decision_added: 0,
              plan_authored: 0,
              agent_run_completed: 12,
            },
            total: 15,
            last_event_ts: 1700000000000,
          },
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AdvContributorsPanel (P-048)', () => {
  it('renders a row per contributor with name + @login', async () => {
    const { container } = render(<AdvContributorsPanel {...props} />);
    await waitFor(() => expect(container.textContent).toContain('@alice'));
    expect(container.textContent).toContain('Alice'); // display_name
    expect(container.textContent).toContain('@bob');
    expect(container.querySelectorAll('.pc-adv-contributors__row').length).toBe(2);
  });

  it('shows the verified contributor\'s tiers, ZEROES the unverified one (P-048d)', async () => {
    const { container } = render(<AdvContributorsPanel {...props} />);
    await waitFor(() => expect(container.textContent).toContain('@alice'));
    const rows = [...container.querySelectorAll('.pc-adv-contributors__row')] as HTMLElement[];
    const aliceRow = rows.find((r) => r.textContent?.includes('@alice'))!;
    const bobRow = rows.find((r) => r.textContent?.includes('@bob'))!;
    // verified alice: real tier numbers
    expect(aliceRow.textContent).toContain('✓3 PR');
    expect(aliceRow.textContent).toContain('✓4 shipped');
    // unverified bob: zeroed despite the mock sending 9s
    expect(bobRow.textContent).toContain('✓0 PR');
    expect(bobRow.textContent).toContain('✓0 shipped');
    expect(bobRow.textContent).toContain('0 act');
    // and greyed
    expect(bobRow.getAttribute('style') || '').toContain('opacity');
  });

  it('marks the viewer\'s own row + links the avatar/name to the profile', async () => {
    const { container } = render(<AdvContributorsPanel {...props} />);
    await waitFor(() => expect(container.textContent).toContain('@alice'));
    expect(container.textContent).toContain('(you)'); // alice is the viewer
    const aliceLink = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('@alice'));
    expect(aliceLink?.getAttribute('href')).toBe('/users/github/42');
  });

  it('renders the device count for contributors with devices', async () => {
    const { container } = render(<AdvContributorsPanel {...props} />);
    await waitFor(() => expect(container.textContent).toContain('@alice'));
    expect(container.textContent).toContain('2 devices'); // alice device_count=2
  });

  it('expands a contributor on activity click and shows the per-kind breakdown', async () => {
    const { container } = render(<AdvContributorsPanel {...props} />);
    await waitFor(() => expect(container.textContent).toContain('@alice'));
    const rows = [...container.querySelectorAll('.pc-adv-contributors__row')] as HTMLElement[];
    const aliceRow = rows.find((r) => r.textContent?.includes('@alice'))!;
    const actBtn = aliceRow.querySelector('.pc-adv-contributors__activity') as HTMLButtonElement;
    expect(actBtn).toBeTruthy();
    fireEvent.click(actBtn);
    // the route fires + the non-zero kinds render in the breakdown
    await waitFor(() => expect(container.textContent).toContain('authored'));
    expect(container.textContent).toContain('runs'); // agent_run_completed label
    // zero-count kinds are omitted
    expect(container.textContent).not.toContain('queued');
  });
});
