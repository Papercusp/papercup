// @vitest-environment jsdom
/**
 * login.test.tsx — the /login auth surface (sign-in + signup). Covers the
 * mount /me branches (auto-redirect, switch-account no-redirect, pgUnavailable
 * no-redirect, single-user autofill, multi-user dropdown), the login + signup
 * submit success/error paths, and the mode toggle.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route with a controllable
 * useSearch + a captured useNavigate), nuqs (?mode= via NuqsTestingAdapter),
 * Select/Checkbox stubbed to native controls, fetch stubbed per-URL.
 *
 * NOTE: this box's jsdom localStorage/sessionStorage methods throw — login
 * reads sessionStorage.setItem + localStorage.length/key/removeItem, so we
 * install Map-backed Storage shims in beforeEach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const navigateMock = vi.fn();
let searchVal: { redirect_to?: string; switch?: 1; mode?: 'login' | 'signup' };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useSearch: () => searchVal }),
  useNavigate: () => navigateMock,
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: {
    value: string; onChange: (v: string) => void; ariaLabel?: string;
    options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">--</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));
vi.mock('@/app/harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange, ariaLabel, disabled }: {
    checked: boolean; onChange: (v: boolean) => void; ariaLabel?: string; disabled?: boolean;
  }) => (
    <input type="checkbox" aria-label={ariaLabel} checked={checked} disabled={disabled}
      onChange={(e) => onChange(e.target.checked)} />
  ),
}));

import { Route } from './login';

/* ── Map-backed Storage shim (jsdom storage is broken on this box) ──── */
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

let fetchRoutes: Record<string, () => { ok: boolean; body: unknown }>;
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(fetchRoutes).find((k) => url.includes(k));
    const r = key ? fetchRoutes[key]() : { ok: true, body: {} };
    return { ok: r.ok, json: async () => r.body } as unknown as Response;
  }));
}

const Login = Route.component as () => JSX.Element;
function renderLogin(over: Partial<typeof searchVal> = {}, searchParams = '') {
  searchVal = { redirect_to: undefined, switch: undefined, mode: undefined, ...over };
  return render(<NuqsTestingAdapter searchParams={searchParams}><Login /></NuqsTestingAdapter>);
}

beforeEach(() => {
  navigateMock.mockReset(); toastSuccess.mockReset(); toastError.mockReset();
  Object.defineProperty(window, 'localStorage', { value: makeStorage(), configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: makeStorage(), configurable: true });
  fetchRoutes = { '/api/auth/me': () => ({ ok: true, body: { user: null, available: [] } }) };
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/login auth surface', () => {
  it('renders the sign-in form (default login mode)', async () => {
    renderLogin();
    expect(await screen.findByRole('heading', { name: /Sign in/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('auto-redirects when /me reports an active session', async () => {
    fetchRoutes['/api/auth/me'] = () => ({ ok: true, body: { user: { id: 'u1', display_name: 'Ada' } } });
    renderLogin({ redirect_to: '/home' });
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/home', replace: true }));
  });

  it('does NOT auto-redirect when pgUnavailable (synthetic default user)', async () => {
    fetchRoutes['/api/auth/me'] = () => ({ ok: true, body: { user: { id: 'def' }, pgUnavailable: true } });
    renderLogin();
    await screen.findByRole('heading', { name: /Sign in/i });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('switch-account mode shows the banner and never auto-redirects', async () => {
    fetchRoutes['/api/auth/me'] = () => ({ ok: true, body: { user: { id: 'u1', display_name: 'Ada' } } });
    renderLogin({ switch: 1 });
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText(/current session will be replaced/i)).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('shows a user dropdown when several accounts are available', async () => {
    fetchRoutes['/api/auth/me'] = () => ({ ok: true, body: { user: null, available: [
      { id: 'a', username: 'ada', display_name: 'Ada', has_password: false },
      { id: 'b', username: 'bob', display_name: 'Bob', has_password: true },
    ] } });
    renderLogin();
    expect(await screen.findByLabelText('User')).toBeTruthy();
  });

  it('login success → welcome toast + navigate + sessionStorage flag', async () => {
    fetchRoutes['/api/auth/me'] = () => ({ ok: true, body: { user: null, available: [
      { id: 'a', username: 'ada', display_name: 'Ada', has_password: false },
    ] } });
    fetchRoutes['/api/auth/login'] = () => ({ ok: true, body: { user: { id: 'a', display_name: 'Ada' } } });
    renderLogin({ redirect_to: '/dash' });
    await screen.findByRole('heading', { name: /Sign in/i });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Welcome, Ada'));
    expect(navigateMock).toHaveBeenCalledWith({ to: '/dash', replace: true });
    expect(window.sessionStorage.getItem('papercusp_just_logged_in')).toBe('Ada');
  });

  it('login failure (bad_password) → error toast, no navigate', async () => {
    fetchRoutes['/api/auth/login'] = () => ({ ok: false, body: { error: 'bad_password' } });
    renderLogin();
    await screen.findByRole('heading', { name: /Sign in/i });
    fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Wrong password.'));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('signup mode shows the display-name field and creates a user', async () => {
    fetchRoutes['/api/auth/signup'] = () => ({ ok: true, body: { user: { id: 'n', display_name: 'Newbie' } } });
    renderLogin({}, '?mode=signup');
    expect(await screen.findByRole('heading', { name: /Create a user/i })).toBeTruthy();
    expect(screen.getByText('Display name')).toBeTruthy();
    fireEvent.submit(screen.getByRole('button', { name: 'Create user' }).closest('form')!);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Welcome, Newbie'));
  });

  it('toggles between login and signup via the switch link', async () => {
    renderLogin();
    await screen.findByRole('heading', { name: /Sign in/i });
    fireEvent.click(screen.getByRole('button', { name: /Create a new user instead/i }));
    expect(await screen.findByRole('heading', { name: /Create a user/i })).toBeTruthy();
  });
});
