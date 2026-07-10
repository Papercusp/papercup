// @vitest-environment jsdom
/**
 * Step B (Tier-1 follow-up arc): /login?switch=1 handling.
 *
 * Asserts:
 *   - ?switch=1 + active session → no auto-redirect, banner visible
 *   - no ?switch + active session → router.replace called
 *   - ?switch=1 + single available user → no autofill
 *   - no ?switch + single available user → autofill happens
 *   - submit-while-switching → other users' welcome stamps are cleared
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

beforeAll(() => {
  // jsdom env in this repo lacks ResizeObserver (Radix uses it) and
  // has a broken localStorage shim. Provide minimal polyfills.
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() { /* noop */ }
      unobserve() { /* noop */ }
      disconnect() { /* noop */ }
    };
  }
  // jsdom's localStorage may be present but with a broken `clear/setItem`
  // signature in some setups. Replace with a Map-backed in-memory shim.
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

const mockReplace = vi.fn();
const mockSearchParamsGet = vi.fn<(k: string) => string | null>();
const mockSetMode = vi.fn();

// page.tsx imports useRouter/useSearchParams from the router-compat layer
// (TanStack-Router-backed), not next/navigation — mock the path the
// component actually imports, else the real hook runs with a null router.
vi.mock('@/lib/router-compat/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  parseAsStringLiteral: () => ({
    withDefault: (defaultValue: string) => ({ defaultValue }),
  }),
  useQueryState: (key: string, parser: { defaultValue: string }) => [
    mockSearchParamsGet(key) ?? parser.defaultValue,
    mockSetMode,
  ],
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import LoginPage from './page';

const origFetch = global.fetch;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  global.fetch = origFetch;
  localStorage.clear();
  sessionStorage.clear();
});

function mockFetch(handlers: Record<string, () => Promise<Response>>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const [path, handler] of Object.entries(handlers)) {
      if (url.includes(path)) return handler();
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LoginPage — ?switch=1 handling', () => {
  beforeEach(() => {
    mockSearchParamsGet.mockReset();
    mockReplace.mockReset();
  });

  it('with ?switch=1 + active session: does NOT redirect; banner visible', async () => {
    mockSearchParamsGet.mockImplementation((k: string) => (k === 'switch' ? '1' : null));
    mockFetch({
      '/api/auth/me': async () =>
        jsonResponse({
          user: { id: 'alice-id', username: 'alice', display_name: 'Alice' },
          available: [],
          autoLogin: false,
        }),
    });

    render(<LoginPage />);

    // Wait for the mount-effect's fetch to resolve.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/auth/me');
    });

    // Crucial: no redirect even though `user` is set.
    expect(mockReplace).not.toHaveBeenCalled();
    // Banner is rendered.
    expect(screen.getByText(/different user/i)).toBeTruthy();
  });

  it('without ?switch + active session: router.replace is called', async () => {
    mockSearchParamsGet.mockImplementation(() => null);
    mockFetch({
      '/api/auth/me': async () =>
        jsonResponse({
          user: { id: 'alice-id', username: 'alice', display_name: 'Alice' },
          available: [],
        }),
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
  });

  it('with ?switch=1 + 1 available user: username field NOT autofilled', async () => {
    mockSearchParamsGet.mockImplementation((k: string) => (k === 'switch' ? '1' : null));
    mockFetch({
      '/api/auth/me': async () =>
        jsonResponse({
          user: null,
          available: [{ username: 'alice', display_name: 'Alice', has_password: false }],
        }),
    });

    render(<LoginPage />);

    // Wait long enough for the effect to settle.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    const usernameInput = screen.getByRole('textbox', { name: /username/i }) as HTMLInputElement;
    expect(usernameInput.value).toBe('');
  });

  it('without ?switch + 1 available user: username field IS autofilled', async () => {
    mockSearchParamsGet.mockImplementation(() => null);
    mockFetch({
      '/api/auth/me': async () =>
        jsonResponse({
          user: null,
          available: [{ username: 'alice', display_name: 'Alice', has_password: false }],
        }),
    });

    render(<LoginPage />);

    await waitFor(() => {
      const usernameInput = screen.getByRole('textbox', { name: /username/i }) as HTMLInputElement;
      expect(usernameInput.value).toBe('alice');
    });
  });


  it('with ?mode=signup opens directly in create-user mode', () => {
    mockSearchParamsGet.mockImplementation((k: string) => (k === 'mode' ? 'signup' : null));
    mockFetch({
      '/api/auth/me': async () =>
        jsonResponse({
          user: null,
          available: [],
        }),
    });

    render(<LoginPage />);

    expect(screen.getByRole('heading', { name: /create a user/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /create user/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in to an existing user/i })).toBeTruthy();
  });
  it('successful switch clears other users\' welcome stamps', async () => {
    mockSearchParamsGet.mockImplementation((k: string) => (k === 'switch' ? '1' : null));

    // Pre-seed stale stamps for two other users plus the target user.
    localStorage.setItem('papercusp_user_welcomed_old-user-1', '1700000000000');
    localStorage.setItem('papercusp_user_welcomed_old-user-2', '1700000000000');
    localStorage.setItem('papercusp_user_welcomed_bob-id', '1700000000000');

    mockFetch({
      '/api/auth/me': async () =>
        jsonResponse({
          user: null,
          available: [{ username: 'bob', display_name: 'Bob', has_password: false }],
        }),
      '/api/auth/login': async () =>
        jsonResponse({ ok: true, user: { id: 'bob-id', display_name: 'Bob' } }),
    });

    render(<LoginPage />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/auth/me'));

    // Manually fill the form (switch mode skips autofill).
    const usernameInput = screen.getByRole('textbox', { name: /username/i }) as HTMLInputElement;
    fireEvent.change(usernameInput, { target: { value: 'bob' } });

    // Submit. The form's submit handler picks login vs signup from `mode`,
    // which defaults to 'login'.
    const submitButton = screen.getByRole('button', { name: /sign in/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Give the post-success cleanup a tick.
    await new Promise((r) => setTimeout(r, 20));

    // Stamps for the OTHER users were cleared; the target user's stamp
    // is left untouched (it'll get set on its own 4am cycle).
    expect(localStorage.getItem('papercusp_user_welcomed_old-user-1')).toBeNull();
    expect(localStorage.getItem('papercusp_user_welcomed_old-user-2')).toBeNull();
    expect(localStorage.getItem('papercusp_user_welcomed_bob-id')).toBe('1700000000000');
  });
});
