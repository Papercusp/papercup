// @vitest-environment jsdom
//
// BrandSwitcher — the navbar Papercup↔Hive branding switcher. The load-bearing
// behavior under test is the OPTIMISTIC flag flip: picking a brand pushes the new
// THE_HIVE value into the client flag store synchronously, so `useFlag` re-renders
// the trigger INSTANTLY (before the POST resolves) instead of waiting on the
// POST → flag-bus → SSE → bootstrap-refetch round-trip. On a failed write it rolls
// back. Mirrors use-account-override's Force/Excl optimism test + ThemeSelector's
// portaled-menu render harness.
//
// Run with: cd apps/operator && npx vitest run app/_components/BrandSwitcher.test.tsx

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

// In-test flag store standing in for @papercusp/flags/client. Both BrandSwitcher
// (getFlagSnapshot/setFlagPayload) and flag-hooks' useFlag (getFlagSnapshot/
// subscribe) read this SAME mocked module, so an optimistic setFlagPayload drives
// the subscribed useFlag to re-render — exactly as in the running app.
const store = vi.hoisted(() => {
  type Flags = Record<string, boolean>;
  let current: { flags: Flags; evaluatedAt: number; source: string } = {
    flags: {},
    evaluatedAt: 0,
    source: 'test',
  };
  const listeners = new Set<(f: Flags) => void>();
  return {
    getFlagSnapshot: () => current,
    setFlagPayload: (p: { flags: Flags; evaluatedAt?: number; source?: string }) => {
      current = { flags: { ...p.flags }, evaluatedAt: p.evaluatedAt ?? 0, source: p.source ?? 'test' };
      for (const l of listeners) l(current.flags);
    },
    subscribe: (fn: (f: Flags) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    subscribeToFlagStream: () => ({ close() {} }),
    loadFlags: async () => current,
    seed: (flags: Flags) => {
      current = { flags: { ...flags }, evaluatedAt: 0, source: 'test' };
      listeners.clear();
    },
  };
});

vi.mock('@papercusp/flags/client', () => ({
  getFlagSnapshot: store.getFlagSnapshot,
  setFlagPayload: store.setFlagPayload,
  subscribe: store.subscribe,
  subscribeToFlagStream: store.subscribeToFlagStream,
  loadFlags: store.loadFlags,
}));

vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { FLAGS } from '@papercusp/flags';
import { toast } from 'sonner';
import BrandSwitcher from './BrandSwitcher';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const json = (ok: boolean, body: unknown) => ({ ok, json: async () => body });
const trigger = () => screen.getByRole('button', { name: /switch branding/i });

beforeEach(() => {
  store.seed({ [FLAGS.THE_HIVE]: false }); // start in classic (Papercup)
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('<BrandSwitcher />', () => {
  it('labels the trigger with the active brand (classic Papercup by default)', () => {
    render(<BrandSwitcher />, { wrapper: withNuqsTestingAdapter({ searchParams: '' }) });
    expect(trigger().textContent).toContain('Papercup');
  });

  it('flips the brand OPTIMISTICALLY before the POST resolves, then reconciles', async () => {
    const post = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return post.promise;
      return Promise.reject(new Error('unexpected non-POST fetch'));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<BrandSwitcher />, { wrapper: withNuqsTestingAdapter({ searchParams: '?brandSwitch=true' }) });
    const menu = await screen.findByRole('menu');

    // Pick "The Swarm" — the optimistic setFlagPayload is synchronous, so the
    // trigger re-labels BEFORE the held-open POST resolves.
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Swarm/ }));
    expect(trigger().textContent).toContain('The Swarm');

    // Server confirms — no flicker, stays on The Swarm.
    post.resolve(json(true, { ok: true, key: FLAGS.THE_HIVE, enabled: true }));
    await waitFor(() => expect(trigger().textContent).toContain('The Swarm'));

    // The flip drove the documented write.
    const postCall = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'POST');
    expect(postCall?.[0]).toBe('/api/flags/set');
    expect(JSON.parse((postCall![1] as { body: string }).body)).toEqual({ key: FLAGS.THE_HIVE, enabled: true });
  });

  it('rolls back to the prior brand when the POST fails', async () => {
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve(json(false, { ok: false, error: 'nope' }));
      return Promise.reject(new Error('unexpected non-POST fetch'));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<BrandSwitcher />, { wrapper: withNuqsTestingAdapter({ searchParams: '?brandSwitch=true' }) });
    const menu = await screen.findByRole('menu');

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Swarm/ }));
    expect(trigger().textContent).toContain('The Swarm'); // optimistic

    // Failed write rolls the local flip back to Papercup.
    await waitFor(() => expect(trigger().textContent).toContain('Papercup'));
    expect(toast.error).toHaveBeenCalled();
  });

  it('picking the already-active brand is a no-op (no write)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(true, { ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    render(<BrandSwitcher />, { wrapper: withNuqsTestingAdapter({ searchParams: '?brandSwitch=true' }) });
    const menu = await screen.findByRole('menu');

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Papercup/ }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
