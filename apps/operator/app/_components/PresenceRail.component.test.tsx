// @vitest-environment jsdom
/**
 * PresenceRail (Mod+U live-agents rail) — the SSE-pushed presence + activity
 * panel (shared-hive-collaboration P-006). Reads the live `dev.coordPresence`
 * (roster: who's online + intent + plan + files) and `dev.coordFeed` (the
 * who-did-what timeline) sync queries — NO polling. Open + tab state are nuqs
 * (`?members`, `?pres`). These tests drive a mocked `useSyncQuery` so we assert
 * the rendered surface + the enabled-gating (no fetch while closed / off-tab).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

// Hoisted shared state the mock factory closes over (vi.mock is hoisted above
// module-scope consts, so the captured refs must be hoisted too).
const { syncResults, syncCalls } = vi.hoisted(() => ({
  syncResults: {} as Record<string, unknown[]>,
  syncCalls: [] as Array<{ queryName: string; enabled?: boolean }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: unknown }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled });
    const enabled = opts.enabled !== false;
    return {
      data: enabled ? (syncResults[opts.queryName] ?? []) : [],
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

import PresenceRail from './PresenceRail';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(syncResults)) delete syncResults[k];
  syncCalls.length = 0;
});

const ROSTER = [
  {
    ownerId: 'su-one',
    ownerLabel: 'su · one',
    intent: 'Implementing the discord shortcuts',
    currentPlanSlug: 'discord-shortcuts-2026-06-06',
    currentFiles: ['apps/operator/app/_components/PresenceRail.tsx'],
    heartbeatAt: new Date().toISOString(),
  },
];

const FEED = [
  {
    msg_id: 'm1',
    ts: new Date().toISOString(),
    from: 'su-4b1a8c13-d500-46a7-bf84-1592bdb5cbcc',
    kind: 'handoff',
    summary: 'Handed off P-006 to su-85dd2',
    plan_slug: 'shared-hive-collaboration-2026-06-14',
  },
];

describe('PresenceRail', () => {
  it('renders the live roster (intent, plan, edited files) from dev.coordPresence while open', async () => {
    syncResults['dev.coordPresence'] = ROSTER;

    render(
      <NuqsTestingAdapter searchParams="?members=true">
        <PresenceRail />
      </NuqsTestingAdapter>,
    );

    const row = await waitFor(() => screen.getByTestId('presence-row'));
    expect(row.textContent).toContain('su · one');
    expect(row.textContent).toContain('Implementing the discord shortcuts');
    expect(row.textContent).toContain('discord-shortcuts-2026-06-06');
    // currentFiles → "who's editing what" (basename, full path in title)
    expect(screen.getByTestId('presence-files').textContent).toContain('PresenceRail.tsx');

    // SSE-pushed, not polled: the roster query is enabled and nothing hits fetch.
    expect(syncCalls.some((c) => c.queryName === 'dev.coordPresence' && c.enabled === true)).toBe(true);
  });

  it('renders nothing and disables the queries while closed (no fetch)', async () => {
    render(
      <NuqsTestingAdapter searchParams="">
        <PresenceRail />
      </NuqsTestingAdapter>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('presence-rail')).toBeNull();
    // The hooks still run (before the early return) but with enabled:false —
    // the transport performs no fetch.
    expect(syncCalls.some((c) => c.queryName === 'dev.coordPresence' && c.enabled === false)).toBe(true);
    expect(syncCalls.every((c) => c.enabled === false)).toBe(true);
  });

  it('shows the who-did-what timeline from dev.coordFeed on the activity tab', async () => {
    syncResults['dev.coordFeed'] = FEED;

    render(
      <NuqsTestingAdapter searchParams="?members=true&pres=activity">
        <PresenceRail />
      </NuqsTestingAdapter>,
    );

    const row = await waitFor(() => screen.getByTestId('activity-row'));
    expect(row.textContent).toContain('su-4b1a8'); // shortened handle
    expect(row.textContent).toContain('Handed off P-006');
    expect(row.textContent).toContain('shared-hive-collaboration-2026-06-14');

    // The feed query is enabled only on the activity tab.
    expect(syncCalls.some((c) => c.queryName === 'dev.coordFeed' && c.enabled === true)).toBe(true);
  });

  it('does not fetch the activity feed while on the roster tab', async () => {
    syncResults['dev.coordPresence'] = ROSTER;
    render(
      <NuqsTestingAdapter searchParams="?members=true">
        <PresenceRail />
      </NuqsTestingAdapter>,
    );
    await waitFor(() => screen.getByTestId('presence-row'));
    // dev.coordFeed is mounted (hook runs) but disabled on the roster tab.
    expect(syncCalls.some((c) => c.queryName === 'dev.coordFeed' && c.enabled === false)).toBe(true);
    expect(syncCalls.some((c) => c.queryName === 'dev.coordFeed' && c.enabled === true)).toBe(false);
  });
});
