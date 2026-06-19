// @vitest-environment jsdom
//
// SessionsPanel regression — the create:sessions dock panel must scope its live
// roster poll to THIS window's workspace. The panel mounts
// <SessionsRosterProvider> (which polls /api/adv/roster); if it forgets to pass
// `workspaceId`, the fetch is unscoped ("every workspace") and switching
// workspaces appears to do nothing — the queen/scout/overwatch roster never
// re-resolves. This test renders the panel with a known active workspace and
// asserts the resulting fetch carries `?workspace=<id>`.
//
// The real SessionsRosterContext (provider + useRoster) runs so we exercise the
// actual fetch-url construction; everything else (heavy grid views, plan data,
// nuqs) is stubbed so the panel mounts in isolation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

vi.mock('@/lib/use-workspace-id', () => ({
  useWorkspaceId: () => 'ws-panel',
}));

vi.mock('nuqs', async () => {
  const React = await import('react');
  const parser = () => ({ withDefault(defaultValue: unknown) { return { defaultValue }; } });
  return {
    parseAsString: parser(),
    parseAsBoolean: parser(),
    useQueryState(_key: string, p?: { defaultValue?: unknown }) {
      return React.useState(p?.defaultValue ?? null);
    },
  };
});

// Plan/scope data the panel reads but this test doesn't care about.
vi.mock('./use-create-data', () => ({
  useCreateScope: () => ({}),
  usePlanListMaps: () => ({ planTitleBySlug: {} }),
  useItemPlanFilter: () => [[]],
}));

// Keep the heavy roster grid + 2-pane shell out of the render — we only assert
// the provider's fetch url. The provider itself stays REAL.
vi.mock('@/app/_components/layout/TwoPaneShell', () => ({
  default: ({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) => (
    <div>{list}{detail}</div>
  ),
}));
vi.mock('@/app/adv/sessions/SessionsRosterView', () => ({
  SessionsRosterList: () => <div data-testid="roster-list" />,
  SessionsRosterDetail: () => <div data-testid="roster-detail" />,
}));

import SessionsPanel from './SessionsPanel';

const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ active: [], ended: [], orphanedClaims: [], pending: [] }),
});
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
});

describe('<SessionsPanel />', () => {
  it('scopes the roster fetch to the active workspace', async () => {
    render(<SessionsPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/adv/roster?workspace=ws-panel');
  });
});
