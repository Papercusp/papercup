// @vitest-environment jsdom
/**
 * AutoLoginWelcomeToast component-level tests.
 *
 * Companion to AutoLoginWelcomeToast.test.ts (pure boundary math).
 * This file mounts the React component and verifies it consumes
 * /api/auth/me correctly — specifically the pgUnavailable
 * suppression path (the synthetic UUID would cause a duplicate
 * welcome toast on next PG-recovered load if we didn't suppress).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

beforeAll(() => {
  // jsdom polyfills (matches the page.test.tsx pattern).
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: ls, configurable: true });
});

vi.mock('sonner', () => ({
  toast: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));

import { toast } from 'sonner';
const toastFn = vi.mocked(toast);

import AutoLoginWelcomeToast from './AutoLoginWelcomeToast';

const origFetch = global.fetch;

afterEach(() => {
  cleanup();
  toastFn.mockReset();
  global.fetch = origFetch;
  localStorage.clear();
  sessionStorage.clear();
});

function mockMeResponse(body: unknown) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes('/api/auth/me')) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  toastFn.mockReset();
});

describe('AutoLoginWelcomeToast — pgUnavailable suppression', () => {
  it('does NOT fire the toast when /api/auth/me returns pgUnavailable:true', async () => {
    mockMeResponse({
      user: { id: '00000000-0000-0000-0000-000000000001', display_name: 'User' },
      autoLogin: true,
      pgUnavailable: true,
    });

    render(<AutoLoginWelcomeToast />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // Give the effect a tick to complete.
    await new Promise((r) => setTimeout(r, 30));

    expect(toastFn).not.toHaveBeenCalled();
    // Also: no stamp was written under the synthetic UUID (so when PG
    // recovers and returns the real user, the welcome fires once cleanly).
    expect(localStorage.getItem('papercusp_user_welcomed_00000000-0000-0000-0000-000000000001')).toBeNull();
  });

  it('DOES fire the toast for a normal /me response (regression smoke)', async () => {
    mockMeResponse({
      user: { id: 'real-uuid-123', display_name: 'Alice' },
      autoLogin: true,
    });

    render(<AutoLoginWelcomeToast />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));

    expect(toastFn).toHaveBeenCalledTimes(1);
    // First-ever for this user → "Signed in as ..."
    expect(toastFn.mock.calls[0][0]).toContain('Alice');
  });
});
