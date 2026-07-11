// @vitest-environment jsdom
//
// Click-flow regression for the curated Conversations (unified inbox). The main
// AdvConversationsTab suite mocks nuqs with a NO-OP setter, so it can only prove
// "click calls setRoute" and "a manually-set route renders the detail" as two
// SEPARATE facts — it never flows a real click end to end. This suite uses a
// STATEFUL nuqs mock (setRoute writes a store and re-renders subscribers), so a
// real fireEvent.click threads through route → detail exactly like the app.
//
// Guards WI-4216: clicking a left-pane row must bring the item into the main
// pane. In particular, when the source detail query resolves EMPTY (a webview
// race where the SSE cache answers before the row is materialized), the clicked
// row's ANCHOR must stay visible — never a bare "Select a thread" that reads as
// "the click did nothing" (the symptom Avi reported). MessagesView already had
// this list-row fallback; ThreadsView/DeliberationsView/AgentChatsView did not.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// ---- stateful nuqs mock: setRoute updates a store and re-renders subscribers ----
const store: Record<string, unknown> = {};
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapCache = new Map<object, { sig: string; val: Record<string, unknown> }>();

vi.mock('nuqs', () => {
  const useQueryState = (key: string) => {
    const value = React.useSyncExternalStore(subscribe, () => store[key], () => store[key]);
    const set = React.useCallback((v: unknown) => {
      store[key] = typeof v === 'function' ? (v as (p: unknown) => unknown)(store[key]) : v;
      emit();
    }, [key]);
    return [value, set];
  };
  const useQueryStates = (parsers: Record<string, unknown>) => {
    const keys = Object.keys(parsers);
    const getSnap = () => {
      const sig = keys.map((k) => `${k}=${JSON.stringify(store[k])}`).join('&');
      const cached = snapCache.get(parsers);
      if (cached && cached.sig === sig) return cached.val;
      const val = Object.fromEntries(keys.map((k) => [k, store[k]]));
      snapCache.set(parsers, { sig, val });
      return val;
    };
    const value = React.useSyncExternalStore(subscribe, getSnap, getSnap);
    const set = React.useCallback((patch: Record<string, unknown>) => {
      Object.assign(store, patch);
      emit();
    }, []);
    return [value, set];
  };
  const p: Record<string, unknown> = {};
  p.withDefault = () => p;
  return {
    useQueryState,
    useQueryStates,
    parseAsString: p,
    parseAsStringEnum: () => p,
    parseAsArrayOf: () => p,
    createParser: () => p,
  };
});

const ready = (data: unknown[] = []): Record<string, unknown> => ({
  data, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE',
});
const syncKey = (q: string, a: Record<string, unknown> = {}) => `${q}:${JSON.stringify(a)}`;
let syncResults: Record<string, Record<string, unknown>> = {};
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args = {}, enabled = true }: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    if (!enabled) return ready();
    return syncResults[syncKey(queryName, args)] ?? syncResults[queryName] ?? ready();
  },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (i: number) => string | number }) => {
    const ROW = 104;
    const items = Array.from({ length: count }, (_, index) => ({
      index, key: getItemKey?.(index) ?? `vrow-${index}`, start: index * ROW, end: index * ROW + ROW, size: ROW, lane: 0,
    }));
    return { getVirtualItems: () => items, getTotalSize: () => count * ROW, measureElement: () => {}, measure: () => {}, scrollToIndex: () => {} };
  },
}));

vi.mock('@/app/harness/ChatPanel', () => ({ default: () => <div data-testid="chat-panel-stub" /> }));

import AdvConversationsTab from './AdvConversationsTab';

const THREAD_TITLE = 'why does the watchdog recycle the host?';

beforeEach(() => {
  Object.assign(store, {
    conv: 'inbox', fkind: [], fadvanced: 'closed', fagent: '', fplan: '', fq: '', fmsg: null,
    cq: '', cvf: {}, conversation: null, cstate: 'open', ckind: 'all', ctopic: '', thread: null,
    acharness: '', acrole: '', chat: null, msg: null, opc: null,
  });
  snapCache.clear();
  syncResults = {
    'conversations.questionsList': ready([{
      id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
      title: THREAD_TITLE, asker_id: 'oracle', topics: ['infra'], promoted_issue_id: null,
      created_ts: new Date(Date.now() - 120_000).toISOString(), updated_ts: new Date(Date.now() - 120_000).toISOString(),
    }]),
    'conversations.deliberationList': ready(),
    'conversations.agentChatList': ready(),
    'conversations.messageList': ready(),
    'dev.coordFeed': ready([]),
    [syncKey('conversations.questionDetail', { id: 'c-1' })]: ready([{
      id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
      title: THREAD_TITLE, asker_id: 'oracle', subscriber_count: 2, topics: ['infra'],
      body: 'the host keeps recycling every few minutes', accepted_answer: null, promoted_issue_id: null, posts: [],
    }]),
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('curated Conversations — a row click reaches the main pane (WI-4216)', () => {
  it('renders the selected detail in the main pane after a real click', async () => {
    render(<AdvConversationsTab />);
    expect(store.conv).toBe('inbox');

    fireEvent.click(screen.getByRole('button', { name: `Open ${THREAD_TITLE}` }));

    // The click atomically switches the source + selection…
    expect(store.conv).toBe('threads');
    expect(store.conversation).toBe('c-1');
    // …and the detail lands in the main pane.
    expect(await screen.findByRole('heading', { level: 2, name: THREAD_TITLE })).toBeTruthy();
  });

  it('keeps the clicked row anchored in the main pane even when its detail resolves empty', async () => {
    // Webview race: the detail query answers empty (loading:false, no row) before
    // the row materializes. The clicked item must still occupy the main pane via
    // its anchor — NOT fall through to the "Select a thread" no-selection state.
    syncResults[syncKey('conversations.questionDetail', { id: 'c-1' })] = ready([]);
    render(<AdvConversationsTab />);

    fireEvent.click(screen.getByRole('button', { name: `Open ${THREAD_TITLE}` }));

    expect(store.conv).toBe('threads');
    expect(await screen.findByRole('heading', { level: 2, name: THREAD_TITLE })).toBeTruthy();
    // The generic "nothing selected" empty state must NOT be what the user sees.
    expect(screen.queryByText('Select a thread')).toBeNull();
  });
});
