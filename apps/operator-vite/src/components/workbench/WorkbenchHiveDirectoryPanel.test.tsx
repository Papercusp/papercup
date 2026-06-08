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
    if (typeof url === 'string' && url === '/api/harness/join-link') {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
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

  it('Join POSTs each member link to /api/harness/join-link', async () => {
    const fetchMock = mockFetch([
      { hiveId: 'joinable', title: 'Joinable', description: '', owner: 'cat', visibility: 'public', memberTopics: ['a', 'b'], memberLinks: ['papercusp://harness?topic=a', 'papercusp://harness?topic=b'], memberCount: 2, createdAt: 1, lastSeenMs: 1 },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<WorkbenchHiveDirectoryPanel />);
    const btn = await screen.findByRole('button', { name: 'Join' });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/Joined 2\/2/)).toBeTruthy());
    const joinCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/harness/join-link');
    expect(joinCalls).toHaveLength(2);
  });
});
