// @vitest-environment jsdom
/**
 * PresenceRail (Mod+U live-agents rail) — fetches /api/coord/presence while
 * open, renders the active roster, and fetches nothing while closed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import PresenceRail from './PresenceRail';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ACTIVE = [
  {
    ownerId: 'su-one',
    ownerLabel: 'su · one',
    intent: 'Implementing the discord shortcuts',
    currentPlanSlug: 'discord-shortcuts-2026-06-06',
    heartbeatAt: new Date().toISOString(),
  },
];

describe('PresenceRail', () => {
  it('renders the active roster from /api/coord/presence while open', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ active: ACTIVE, stale: [] }) } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <NuqsTestingAdapter searchParams="?members=true">
        <PresenceRail />
      </NuqsTestingAdapter>,
    );

    const row = await waitFor(() => screen.getByTestId('presence-row'));
    expect(row.textContent).toContain('su · one');
    expect(row.textContent).toContain('Implementing the discord shortcuts');
    expect(row.textContent).toContain('discord-shortcuts-2026-06-06');
    expect(fetchMock).toHaveBeenCalledWith('/api/coord/presence', expect.anything());
  });

  it('renders nothing and fetches nothing while closed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <NuqsTestingAdapter searchParams="">
        <PresenceRail />
      </NuqsTestingAdapter>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('presence-rail')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
