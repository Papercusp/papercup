// @vitest-environment jsdom
//
// WorkbenchHiveDirectoryPanel render + Join CTA gating (p2p-hive-directory P-007).
// P-009 (data-sync-push-completion): the directory is now push-driven via the
// `network.hiveDirectory` sync query (not the old /api/discovery/pots poll), so
// the directory data is mocked through useSyncQuery (the AdvNowRunning pattern);
// only the Join POST still goes through fetch. Refresh now calls the query's
// invalidate().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

// The panel-registry import pulls in @/app dock code; stub it to a no-op registry.
vi.mock('@/app/harness/dock/panel-registry', () => ({
  panelRegistry: { register: () => {} },
}));

// Push-driven sync mock — the panel subscribes to network.hiveDirectory. `dirRows`
// is the live discovered set; `invalidateSpy` is the Refresh handler we assert on.
let dirRows: unknown[] | undefined = [];
const invalidateSpy = vi.fn();
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    if (queryName === 'network.hiveDirectory') {
      return { data: dirRows, error: null, invalidate: invalidateSpy };
    }
    return { data: undefined, error: null, invalidate: () => {} };
  },
}));

// Lexicon resolver echoes its key (t('pot') → 'pot', opts ignored) — isolates the
// hive→pot routed copy from the THE_HIVE flag hook (restore-pot-lexicon P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import { WorkbenchHiveDirectoryPanel } from './WorkbenchHiveDirectoryPanel';

// The panel is a dock panel — it receives PanelComponentProps and sets its live
// title via api.setTitle. Supply an inert api so rendering standalone works.
const panelProps = {
  panelId: 'p1',
  panelType: 'workbench:hive-directory',
  params: {},
  api: { setParams: () => {}, setTitle: () => {}, close: () => {} },
};

function mockJoinFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    // D-007 (hive-from-repo-hardening): Join makes ONE composed call to
    // /api/discovery/join-pot (join the HIVE + materialize the local view),
    // not N per-link /api/harness/join-link POSTs. Response carries per-member
    // results so the panel can report "<okCount>/<total> member(s)".
    if (typeof url === 'string' && url === '/api/discovery/join-pot') {
      const body = JSON.parse((init?.body as string) ?? '{}') as { memberLinks?: string[]; hiveId?: string };
      const members = (body.memberLinks ?? []).map(() => ({ ok: true }));
      return {
        ok: true,
        json: async () => ({ ok: true, hiveSlug: `${body.hiveId}-hive`, members }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

beforeEach(() => {
  dirRows = [];
  invalidateSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorkbenchHiveDirectoryPanel (P-007 / P-009)', () => {
  it('renders discovered hives (title/owner/visibility)', async () => {
    dirRows = [
      { hiveId: 'ash', title: 'Ash Hive', description: 'shop work', owner: 'alice', visibility: 'public', memberTopics: ['a'], memberLinks: ['papercusp://harness?topic=a'], memberCount: 1, createdAt: 1, lastSeenMs: 1 },
    ];
    render(<WorkbenchHiveDirectoryPanel {...panelProps} />);
    expect(await screen.findByText('Ash Hive')).toBeTruthy();
    expect(screen.getByText(/owner: alice/)).toBeTruthy();
  });

  it('shows the loading state while the first push has not resolved', () => {
    dirRows = undefined;
    render(<WorkbenchHiveDirectoryPanel {...panelProps} />);
    expect(screen.getByText(/Loading the pot directory/)).toBeTruthy();
  });

  it('shows the empty-state when no hives are discovered', async () => {
    dirRows = [];
    render(<WorkbenchHiveDirectoryPanel {...panelProps} />);
    expect(await screen.findByText(/No pot discovered yet/)).toBeTruthy();
  });

  it('disables Join + shows "link required" for a topic-only hive (no member links)', async () => {
    dirRows = [
      { hiveId: 'topic-only', title: 'Topic Hive', description: '', owner: 'bob', visibility: 'public', memberTopics: ['a', 'b'], memberLinks: [], memberCount: 2, createdAt: 1, lastSeenMs: 1 },
    ];
    render(<WorkbenchHiveDirectoryPanel {...panelProps} />);
    const btn = (await screen.findByRole('button', { name: 'Join' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('link required')).toBeTruthy();
  });

  it('P-009: Refresh forces the push query to re-fetch (invalidate), not a poll', async () => {
    dirRows = [
      { hiveId: 'ash', title: 'Ash Hive', description: '', owner: 'al', visibility: 'public', memberTopics: ['a'], memberLinks: [], memberCount: 1, createdAt: 1, lastSeenMs: 1 },
    ];
    render(<WorkbenchHiveDirectoryPanel {...panelProps} />);
    fireEvent.click(await screen.findByTestId('hive-directory-refresh'));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('Join makes ONE composed POST to /api/discovery/join-pot carrying every member link (D-007)', async () => {
    dirRows = [
      { hiveId: 'joinable', title: 'Joinable', description: '', owner: 'cat', visibility: 'public', memberTopics: ['a', 'b'], memberLinks: ['papercusp://harness?topic=a', 'papercusp://harness?topic=b'], memberCount: 2, createdAt: 1, lastSeenMs: 1 },
    ];
    const fetchMock = mockJoinFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkbenchHiveDirectoryPanel {...panelProps} />);
    const btn = await screen.findByRole('button', { name: 'Join' });
    fireEvent.click(btn);
    // The panel reports the hive slug + member tally from the composed response.
    await waitFor(() => expect(screen.getByText(/Joined pot .* 2\/2 member/)).toBeTruthy());
    // Exactly ONE join-hive call (not N loose join-link calls), carrying both links.
    const joinCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/discovery/join-pot');
    expect(joinCalls).toHaveLength(1);
    const sent = JSON.parse((joinCalls[0][1] as RequestInit).body as string) as { hiveId: string; memberLinks: string[] };
    expect(sent.hiveId).toBe('joinable');
    expect(sent.memberLinks).toHaveLength(2);
    // The retired per-link endpoint is no longer hit.
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/harness/join-link')).toHaveLength(0);
  });
});
