// @vitest-environment jsdom
//
// SessionsPanel regression — the create:sessions dock panel must scope its live
// roster read to THIS window's workspace. The panel mounts
// <SessionsRosterProvider> (which reads `advRoster.list` via @papercusp/sync); if
// it forgets to pass `workspaceId`, the read is unscoped ("every workspace") and
// switching workspaces appears to do nothing — the queen/scout/overwatch roster
// never re-resolves. This test renders the panel with a known active workspace
// and asserts the resulting sync query carries `args.workspaceId === '<id>'`.
//
// The real SessionsRosterContext (provider + useRoster) runs so we exercise the
// actual query-args construction; @papercusp/sync's useSyncQuery is mocked so we
// capture the args without standing up a transport, and everything else (heavy
// grid views, plan data, nuqs) is stubbed so the panel mounts in isolation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

// Capture the args the provider hands to the sync layer. useSyncQuery is the one
// audited data path (the roster moved off a raw fetch onto @papercusp/sync), so
// asserting on its args is what truthfully verifies "the roster read is scoped
// to the active workspace".
const useSyncQueryMock = vi.fn().mockReturnValue({
  data: [{ active: [], ended: [], orphanedClaims: [], pending: [] }],
  loading: false,
  error: null,
  invalidate: () => {},
});
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: unknown) => useSyncQueryMock(opts),
}));

vi.mock('@/lib/use-workspace-id', () => ({
  useWorkspaceId: () => 'ws-panel',
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', async () => {
  const React = await import('react');
  const parser = () => ({ withDefault(defaultValue: unknown) { return { defaultValue }; } });
  return {
    ...nuqsParsers,
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
// the provider's query args. The provider itself stays REAL.
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

afterEach(() => {
  cleanup();
  useSyncQueryMock.mockClear();
});

describe('<SessionsPanel />', () => {
  it('scopes the roster fetch to the active workspace', async () => {
    render(<SessionsPanel />);
    await waitFor(() => expect(useSyncQueryMock).toHaveBeenCalled());
    const opts = useSyncQueryMock.mock.calls[0]?.[0] as {
      queryName?: string;
      args?: { workspaceId?: unknown };
    };
    expect(opts?.queryName).toBe('advRoster.list');
    expect(opts?.args?.workspaceId).toBe('ws-panel');
  });
});
