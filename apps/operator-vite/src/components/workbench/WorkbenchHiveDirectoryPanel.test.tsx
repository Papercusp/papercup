// @vitest-environment jsdom
//
// WorkbenchHiveDirectoryPanel render + Join CTA gating (p2p-hive-directory P-007).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

// The panel-registry import pulls in @/app dock code; stub it to a no-op registry.
vi.mock('@/app/harness/dock/panel-registry', () => ({
  panelRegistry: { register: () => {} },
}));

import { WorkbenchHiveDirectoryPanel } from './WorkbenchHiveDirectoryPanel';

function mockFetch(rows: unknown[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.startsWith('/api/discovery/hives')) {
      return { ok: true, json: async () => ({ count: rows.length, rows }) } as Response;
    }
    // D-007 (hive-from-repo-hardening): Join now makes ONE composed call to
    // /api/discovery/join-hive (join the HIVE + materialize the local view),
    // not N per-link /api/harness/join-link POSTs. Response carries per-member
    // results so the panel can report "<okCount>/<total> member(s)".
    if (typeof url === 'string' && url === '/api/discovery/join-hive') {
      const body = JSON.parse((init?.body as string) ?? '{}') as { memberLinks?: string[] };
      const members = (body.memberLinks ?? []).map(() => ({ ok: true }));
      return {
        ok: true,
        json: async () => ({ ok: true, hiveSlug: `${(JSON.parse((init?.body as string) ?? '{}') as { hiveId?: string }).hiveId}-hive`, members }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorkbenchHiveDirectoryPanel (P-007)', () => {
  it('renders discovered hives (title/owner/visibility)', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { hiveId: 'ash', title: 'Ash Hive', description: 'shop work', owner: 'alice', visibility: 'public', memberTopics: ['a'], memberLinks: ['papercusp://harness?topic=a'], memberCount: 1, createdAt: 1, lastSeenMs: 1 },
    ]));
    render(<WorkbenchHiveDirectoryPanel />);
    expect(await screen.findByText('Ash Hive')).toBeTruthy();
    expect(screen.getByText(/owner: alice/)).toBeTruthy();
  });

  it('shows the empty-state when no hives are discovered', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    render(<WorkbenchHiveDirectoryPanel />);
    expect(await screen.findByText(/No hives discovered yet/)).toBeTruthy();
  });

  it('disables Join + shows "link required" for a topic-only hive (no member links)', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { hiveId: 'topic-only', title: 'Topic Hive', description: '', owner: 'bob', visibility: 'public', memberTopics: ['a', 'b'], memberLinks: [], memberCount: 2, createdAt: 1, lastSeenMs: 1 },
    ]));
    render(<WorkbenchHiveDirectoryPanel />);
    const btn = (await screen.findByRole('button', { name: 'Join' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('link required')).toBeTruthy();
  });

  it('G-003: Refresh re-fetches the live directory — a withdrawn hive disappears (no remount)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/discovery/hives')) {
        call += 1;
        // First load shows the hive; after the owner withdraws it, the next
        // fetch returns it gone — the panel must converge (brief scenario 3:
        // "stale/withdrawn hives disappear"), not freeze the mount-time snapshot.
        const rows = call === 1
          ? [{ hiveId: 'gone', title: 'Soon Gone', description: '', owner: 'al', visibility: 'public', memberTopics: ['a'], memberLinks: [], memberCount: 1, createdAt: 1, lastSeenMs: 1 }]
          : [];
        return { ok: true, json: async () => ({ count: rows.length, rows }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkbenchHiveDirectoryPanel />);
    expect(await screen.findByText('Soon Gone')).toBeTruthy();
    fireEvent.click(screen.getByTestId('hive-directory-refresh'));
    await waitFor(() => expect(screen.queryByText('Soon Gone')).toBeNull());
    expect(screen.getByText(/No hives discovered yet/)).toBeTruthy();
  });

  it('Join makes ONE composed POST to /api/discovery/join-hive carrying every member link (D-007)', async () => {
    const fetchMock = mockFetch([
      { hiveId: 'joinable', title: 'Joinable', description: '', owner: 'cat', visibility: 'public', memberTopics: ['a', 'b'], memberLinks: ['papercusp://harness?topic=a', 'papercusp://harness?topic=b'], memberCount: 2, createdAt: 1, lastSeenMs: 1 },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkbenchHiveDirectoryPanel />);
    const btn = await screen.findByRole('button', { name: 'Join' });
    fireEvent.click(btn);
    // The panel reports the hive slug + member tally from the composed response.
    await waitFor(() => expect(screen.getByText(/Joined hive .* 2\/2 member/)).toBeTruthy());
    // Exactly ONE join-hive call (not N loose join-link calls), carrying both links.
    const joinCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/discovery/join-hive');
    expect(joinCalls).toHaveLength(1);
    const sent = JSON.parse((joinCalls[0][1] as RequestInit).body as string) as { hiveId: string; memberLinks: string[] };
    expect(sent.hiveId).toBe('joinable');
    expect(sent.memberLinks).toHaveLength(2);
    // The retired per-link endpoint is no longer hit.
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/harness/join-link')).toHaveLength(0);
  });
});
