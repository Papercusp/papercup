// @vitest-environment jsdom
/**
 * WorkItemPopupModal (chat-ref-pills-2026-07-26 P-008) — a clicked WI-/EI-/F-
 * ref pill opens this AS A POPUP (D-001) instead of navigating the Working
 * tab. Asserts: closed when `id` is null; the harness-gated empty state when
 * `harnessSlug` is missing (and the query stays disabled — never guesses
 * across harnesses); loading/not-found degrades; a resolved row renders the
 * REAL `WorkItemDetail` body unchanged; its own cross-link (`onSelect`)
 * passes straight through; and the close button/Escape both fire `onClose`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const openFeatureChat = vi.fn();
vi.mock('@papercusp/papercusp-shared', () => ({
  openFeatureChat: (...args: unknown[]) => openFeatureChat(...args),
}));

// WI-6023: the popup HOSTS ChatPanel (the PlanChat precedent). Stubbed here —
// the real panel opens an EventSource and runs its own sync queries, none of
// which this component's contract depends on. What matters is that the popup
// mounts it with the resolved chatId.
vi.mock('../../harness/ChatPanel', () => ({
  default: ({ slug, chatId, mode }: { slug: string; chatId: string; mode?: string }) => (
    <div data-testid="chat-panel" data-slug={slug} data-chat-id={chatId} data-mode={mode} />
  ),
}));

const { syncResults, syncLoading, syncCalls } = vi.hoisted(() => ({
  syncResults: {} as Record<string, unknown[]>,
  syncLoading: { current: false },
  syncCalls: [] as Array<{ queryName: string; enabled?: boolean; args?: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: unknown }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    return {
      data: enabled ? (syncResults[opts.queryName] ?? []) : [],
      loading: enabled && syncLoading.current,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

import WorkItemPopupModal from './WorkItemPopupModal';

afterEach(() => {
  cleanup();
  openFeatureChat.mockReset();
  for (const k of Object.keys(syncResults)) delete syncResults[k];
  syncLoading.current = false;
  syncCalls.length = 0;
});

describe('WorkItemPopupModal — open/closed', () => {
  it('renders nothing when id is null (closed)', () => {
    render(<WorkItemPopupModal id={null} harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId('wi-popup-body')).toBeNull();
  });
});

describe('WorkItemPopupModal — harness gating', () => {
  it('renders a "no harness context" empty state and never queries when harnessSlug is null', () => {
    render(<WorkItemPopupModal id="WI-5952" harnessSlug={null} onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/No harness context for WI-5952/)).toBeTruthy();
    const call = syncCalls.find((c) => c.queryName === 'workItems.detail');
    expect(call?.enabled).toBe(false);
  });
});

describe('WorkItemPopupModal — loading / not-found / found', () => {
  it('shows a loading state while the query is in flight', () => {
    syncLoading.current = true;
    render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/Loading WI-5952/)).toBeTruthy();
  });

  it('shows "no item found" when the query settles with no matching row', () => {
    syncResults['workItems.detail'] = [];
    render(<WorkItemPopupModal id="WI-9999" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/No item found for WI-9999/)).toBeTruthy();
  });

  it('queries workItems.detail scoped to harnessSlug + id', () => {
    syncResults['workItems.detail'] = [
      { id: 'WI-5952', kind: 'task', family: 'issue', title: 'Build the popup', state: 'wip' },
    ];
    render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    const call = syncCalls.find((c) => c.queryName === 'workItems.detail');
    expect(call).toMatchObject({ enabled: true, args: { harnessSlug: 'papercusp', id: 'WI-5952' } });
  });

  it('renders the REAL WorkItemDetail body (id + title) for a resolved row, unforked', () => {
    syncResults['workItems.detail'] = [
      { id: 'WI-5952', kind: 'task', family: 'issue', title: 'Build the popup', state: 'wip' },
    ];
    render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText('WI-5952')).toBeTruthy();
    expect(screen.getByText('Build the popup')).toBeTruthy();
    // WorkItemDetail's own Chat affordance proves this is the real component,
    // not a re-hosted fork.
    expect(screen.getByTestId('wi-detail-chat')).toBeTruthy();
  });
});

describe('WorkItemPopupModal — cross-link + close', () => {
  it('forwards WorkItemDetail\'s own cross-link (a feature-family "Open feature detail" click) straight to onSelect', () => {
    syncResults['workItems.detail'] = [
      { id: 'F-100', kind: 'feature', family: 'feature', title: 'A feature', state: 'open' },
    ];
    const onSelect = vi.fn();
    render(<WorkItemPopupModal id="F-100" harnessSlug="papercusp" onSelect={onSelect} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/Open feature detail/));
    expect(onSelect).toHaveBeenCalledWith('F-100');
  });

  it('the close button fires onClose', () => {
    syncResults['workItems.detail'] = [
      { id: 'WI-5952', kind: 'task', family: 'issue', title: 'Build the popup', state: 'wip' },
    ];
    const onClose = vi.fn();
    render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('wi-popup-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * WI-6023 (owner-reported: "the chat button in the work item popup doesn't
 * work"). The popup is mounted by OperatorChat, whose tree contains NO dock —
 * and the only OPEN_CHAT_EVENT listeners are HarnessesDock / PiTerminalsDock.
 * So the pre-fix button awaited its fetch, dispatched into a tree with no
 * listener, and reset its spinner: no error, no toast, indistinguishable from
 * a dead control.
 *
 * These assert the OBSERVABLE effect, not merely that the handler ran. The
 * suite was green before the fix precisely because it only ever asserted the
 * button EXISTS — the same shape as EI-18694403367371331, where a failure
 * rendered identically to a legitimate empty state.
 */
describe('WorkItemPopupModal — hosted chat (WI-6023)', () => {
  const row = { id: 'WI-5952', kind: 'task', family: 'issue', title: 'Build the popup', state: 'wip' };

  it('pressing Chat HOSTS a chat panel in the popup (the button has a visible effect)', async () => {
    syncResults['workItems.detail'] = [row];
    openFeatureChat.mockResolvedValue({ chatId: 'chat-abc' });
    render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);

    expect(screen.queryByTestId('wi-popup-chat')).toBeNull();
    fireEvent.click(screen.getByTestId('wi-detail-chat'));
    await screen.findByTestId('wi-popup-chat');
    expect(screen.getByTestId('chat-panel').getAttribute('data-chat-id')).toBe('chat-abc');
  });

  it('suppresses the dock dispatch so the pending-opens queue is not poisoned', async () => {
    syncResults['workItems.detail'] = [row];
    openFeatureChat.mockResolvedValue({ chatId: 'chat-abc' });
    const seen: Event[] = [];
    const listener = (e: Event) => seen.push(e);
    window.addEventListener('papercusp:open-chat', listener);
    try {
      render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
      fireEvent.click(screen.getByTestId('wi-detail-chat'));
      await screen.findByTestId('wi-popup-chat');
      // The popup passes dispatch:false — without it the detail ALSO lands on
      // window.__PAPERCUSP_PENDING_CHAT_OPENS__, and the next dock to mount
      // replays a backlog of stale opens somewhere else entirely.
      expect(openFeatureChat).toHaveBeenCalledWith(expect.objectContaining({ dispatch: false }));
      expect(seen).toHaveLength(0);
    } finally {
      window.removeEventListener('papercusp:open-chat', listener);
    }
  });

  it('the back control returns to the work-item detail', async () => {
    syncResults['workItems.detail'] = [row];
    openFeatureChat.mockResolvedValue({ chatId: 'chat-abc' });
    render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('wi-detail-chat'));
    await screen.findByTestId('wi-popup-chat');
    fireEvent.click(screen.getByTestId('wi-popup-chat-back'));
    expect(screen.queryByTestId('wi-popup-chat')).toBeNull();
    expect(screen.getByTestId('wi-detail-chat')).toBeTruthy();
  });

  it('re-targeting the popup to another id drops the hosted chat (no stale panel over the new item)', async () => {
    syncResults['workItems.detail'] = [row];
    openFeatureChat.mockResolvedValue({ chatId: 'chat-abc' });
    const { rerender } = render(
      <WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('wi-detail-chat'));
    await screen.findByTestId('wi-popup-chat');

    syncResults['workItems.detail'] = [{ ...row, id: 'WI-6000', title: 'A different item' }];
    rerender(<WorkItemPopupModal id="WI-6000" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId('wi-popup-chat')).toBeNull();
    expect(screen.getByText('A different item')).toBeTruthy();
  });

  it('a failed open does NOT host an empty panel', async () => {
    syncResults['workItems.detail'] = [row];
    openFeatureChat.mockResolvedValue({ error: 'HTTP 500' });
    render(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('wi-detail-chat'));
    await Promise.resolve();
    expect(screen.queryByTestId('wi-popup-chat')).toBeNull();
  });
});
