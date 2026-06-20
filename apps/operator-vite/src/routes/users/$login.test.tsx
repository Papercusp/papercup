// @vitest-environment jsdom
/**
 * $login.test.tsx — /users/$login redirect resolver. Resolves a username via
 * GET /api/users/by-login/:login then client-navigates to the canonical
 * numeric /users/github/:id route. Covers: invalid/over-long-login guard,
 * the looking-up state, 404 not-found, non-404 HTTP error, success →
 * navigate(replace), a body with no id, and a fetch rejection.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route with a controllable
 * useParams + a captured useNavigate), fetch stubbed per-call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const navigateMock = vi.fn();
let paramsVal: { login: string };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useParams: () => paramsVal }),
  useNavigate: () => navigateMock,
}));

import { Route } from './$login';

const Comp = Route.component as () => JSX.Element;

let fetchImpl: (url: string) => { status?: number; ok: boolean; body: unknown };
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = fetchImpl(url);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as unknown as Response;
  }));
}

function renderLogin(login = 'ada') {
  paramsVal = { login };
  return render(<Comp />);
}

beforeEach(() => {
  navigateMock.mockReset();
  fetchImpl = () => ({ ok: true, body: { github_user_id: 42 } });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/users/$login redirect resolver', () => {
  it('shows the looking-up state while resolving', () => {
    renderLogin('ada');
    expect(screen.getByText(/Looking up @ada/i)).toBeTruthy();
  });

  it('rejects an over-long username without fetching', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    renderLogin('x'.repeat(101));
    expect(screen.getByText(/Invalid username/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('navigates to the canonical numeric route on success', async () => {
    fetchImpl = () => ({ ok: true, body: { github_user_id: 7 } });
    renderLogin('ada');
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({
      to: '/users/github/$id', params: { id: '7' }, replace: true,
    }));
  });

  it('renders a not-found state on 404 (no navigate)', async () => {
    fetchImpl = () => ({ ok: false, status: 404, body: {} });
    renderLogin('ghost');
    expect(await screen.findByText(/No profile found for @ghost/i)).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('surfaces a non-404 HTTP error', async () => {
    fetchImpl = () => ({ ok: false, status: 500, body: {} });
    renderLogin('ada');
    expect(await screen.findByText(/HTTP 500/i)).toBeTruthy();
  });

  it('surfaces a resolved body that carries no github_user_id', async () => {
    fetchImpl = () => ({ ok: true, body: { error: 'no id here' } });
    renderLogin('ada');
    expect(await screen.findByText(/no id here/i)).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('surfaces a fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    renderLogin('ada');
    expect(await screen.findByText(/network down/i)).toBeTruthy();
  });
});
