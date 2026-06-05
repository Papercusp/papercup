// @vitest-environment jsdom
/**
 * CoordinationClient render test (coordination-integration-adoption Capstone P2).
 *
 * The three operator-level coordination views (Issues / Topics / Conversations)
 * fetch through /api/admin/coordination/<group>/<verb> and render rows. This pins
 * the React-render contract: the three subtabs exist, the default Issues view
 * renders a row from fetched data, and switching to Topics / Conversations loads
 * + renders those surfaces — so a restyle or a data-shape drift can't silently
 * blank a tab.
 *
 * The canned responses below mirror the SHAPES returned by the live
 * /api/admin/coordination proxy (issues:list / topics:list / conversations:list),
 * which are verified against :3070 separately (proxy → MCP handlers → PG). This
 * test is the React-render half; together they cover the tab end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import CoordinationClient from './CoordinationClient';

// Keyed by the verb path the coord() helper hits (fetch('/api/admin/coordination/<verb>')).
const RESPONSES: Record<string, unknown> = {
  'issues/list': {
    ok: true,
    issues: [
      { id: 'EI-1', title: 'Demo blocker issue', severity: 'major', state: 'open', scope: 'operator', assignee: null, source: 'su' },
    ],
  },
  'topics/list': {
    ok: true,
    topics: [{ slug: 'coordination-substrate', title: 'Coordination substrate', description: 'the substrate', subscribed: false }],
  },
  'conversations/list': {
    ok: true,
    conversations: [{ id: 'C-1', kind: 'question', title: 'How does fan-out work?', state: 'open' }],
  },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const verb = String(url).replace('/api/admin/coordination/', '');
      const body = RESPONSES[verb] ?? { ok: true };
      return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function renderClient(searchParams = '') {
  return render(<CoordinationClient />, { wrapper: withNuqsTestingAdapter({ searchParams }) });
}

describe('CoordinationClient — Capstone P2 admin views', () => {
  it('renders the three coordination subtabs + the default Issues view populates a row from fetched data', async () => {
    renderClient();
    // Subtabs render synchronously.
    expect(screen.getByRole('button', { name: 'Issues' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Topics' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conversations' })).toBeTruthy();
    // The default Issues panel fetches issues:list and renders the row (await settles the fetch).
    expect(await screen.findByText('Demo blocker issue')).toBeTruthy();
    expect(screen.getByText(/EI-1/)).toBeTruthy();
  });

  it('Topics tab loads + renders a topic row (cross-object index entry point)', async () => {
    renderClient('?tab=topics');
    expect(await screen.findByText('#coordination-substrate')).toBeTruthy();
  });

  it('Conversations tab loads + renders a conversation row (su-9fd2d surface)', async () => {
    renderClient('?tab=conversations');
    expect(await screen.findByText('How does fan-out work?')).toBeTruthy();
  });

  it('shows the empty state when a list comes back empty', async () => {
    (RESPONSES['issues/list'] as { issues: unknown[] }).issues = [];
    renderClient();
    expect(await screen.findByText('No issues.')).toBeTruthy();
    // restore for any later run
    (RESPONSES['issues/list'] as { issues: unknown[] }).issues = [
      { id: 'EI-1', title: 'Demo blocker issue', severity: 'major', state: 'open', scope: 'operator', assignee: null, source: 'su' },
    ];
  });
});
