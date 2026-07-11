// @vitest-environment jsdom
//
// RecentActionsCenter — the recent-actions popover bell.
// The real logic is readActiveSlug(): it resolves the active harness slug from
// the URL (?slug / ?project / /harness/<slug>) with a localStorage fallback and
// a strict validity guard. That's extracted + tested branch-by-branch. A
// render-smoke drives the popover surface with OperatorActionLog + Popover
// mocked so we assert the no-slug vs has-slug branches without a live transport.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  parseAsBoolean: { withDefault: (d: boolean) => ({ defaultValue: d }) },
  useQueryState: (_key: string, parser?: { defaultValue?: boolean }) => {
    const React = require('react') as typeof import('react');
    return React.useState<boolean>(parser?.defaultValue ?? false);
  },
}));

// browser-workspace's wsLocalKey namespaces the localStorage key by workspace.
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `ws:default:${k}`,
}));

// OperatorActionLog drives its own sync transport; stub it to a marker so the
// has-slug branch is observable without mocking the whole sync stack here.
vi.mock('./OperatorActionLog', () => ({
  OperatorActionLog: ({ slug }: { slug: string }) => <div data-testid="action-log">log:{slug}</div>,
}));

// Popover wraps Radix; render the trigger + children inline (always-open) so
// the panel content is in the DOM for assertions.
vi.mock('../harness/Popover', () => ({
  Popover: ({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
}));

import { RecentActionsCenter, readActiveSlug } from './RecentActionsCenter';

// jsdom only allows same-origin history updates (default origin is
// http://localhost:3000) — pass a relative URL so the path+query change applies.
function setUrl(relative: string) {
  window.history.replaceState(null, '', relative);
}

// This project's jsdom ships a localStorage shell whose methods throw; install
// a real in-memory Storage so the activeProject fallback reads/writes work.
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, v: string) { store.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: shim, configurable: true, writable: true });
}

beforeEach(() => {
  installLocalStorageShim();
  setUrl('/');
});
afterEach(cleanup);

describe('readActiveSlug', () => {
  it('reads ?slug= from the query string', () => {
    setUrl('/anything?slug=my-harness');
    expect(readActiveSlug()).toBe('my-harness');
  });

  it('falls back to ?project= when slug is absent', () => {
    setUrl('/x?project=proj-1');
    expect(readActiveSlug()).toBe('proj-1');
  });

  it('parses the slug out of a /harness/<slug> path', () => {
    setUrl('/harness/path-harness');
    expect(readActiveSlug()).toBe('path-harness');
  });

  it('rejects an invalid slug and falls through to null', () => {
    setUrl('/x?slug=' + encodeURIComponent('not a slug!'));
    expect(readActiveSlug()).toBeNull();
  });

  it('uses the localStorage activeProject fallback when the URL has no slug', () => {
    window.localStorage.setItem('ws:default:harness.activeProject', 'saved-harness');
    setUrl('/harness');
    expect(readActiveSlug()).toBe('saved-harness');
  });

  it('ignores an invalid localStorage value', () => {
    window.localStorage.setItem('ws:default:harness.activeProject', 'bad slug!!');
    setUrl('/harness');
    expect(readActiveSlug()).toBeNull();
  });

  it('prefers the URL slug over the localStorage fallback', () => {
    window.localStorage.setItem('ws:default:harness.activeProject', 'saved-harness');
    setUrl('/x?slug=url-harness');
    expect(readActiveSlug()).toBe('url-harness');
  });
});

describe('<RecentActionsCenter />', () => {
  it('shows the pick-a-harness empty state when no slug resolves', () => {
    setUrl('/harness');
    render(<RecentActionsCenter />);
    expect(screen.getByText(/pick a harness to see its action log/i)).toBeTruthy();
  });

  it('renders the OperatorActionLog for the resolved slug', () => {
    setUrl('/x?slug=live-harness');
    render(<RecentActionsCenter />);
    expect(screen.getByTestId('action-log').textContent).toBe('log:live-harness');
  });

  it('re-reads the slug on a popstate navigation', async () => {
    setUrl('/harness'); // no slug → empty state
    render(<RecentActionsCenter />);
    expect(screen.getByText(/pick a harness/i)).toBeTruthy();
    // Navigate to a slugged URL and fire popstate → the listener re-resolves.
    setUrl('/x?slug=nav-harness');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await waitFor(() => expect(screen.getByTestId('action-log').textContent).toBe('log:nav-harness'));
  });

  it('the close button is wired (clicking it does not throw)', () => {
    setUrl('/x?slug=live-harness');
    render(<RecentActionsCenter />);
    // A destructure/handler bug here (BackupsTab-class) would throw on click.
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.getByLabelText('Recent actions')).toBeTruthy();
  });
});
