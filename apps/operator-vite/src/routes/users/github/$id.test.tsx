// @vitest-environment jsdom
/**
 * $id.test.tsx — /users/github/$id canonical profile route. Fetches
 * GET /api/users/github/:id then renders <UserProfile>. Covers: non-numeric
 * and non-positive id guards (no fetch), the loading state, the success
 * render, a non-ok HTTP error, a missing-profile body, and a fetch throw.
 * UserProfile is stubbed — it carries its own coverage.
 *
 * Seam: @tanstack/react-router (createFileRoute → Route with controllable
 * useParams), fetch stubbed per-call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let paramsVal: { id: string };
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useParams: () => paramsVal }),
}));
vi.mock('@/app/users/github/[id]/UserProfile', () => ({
  UserProfile: ({ data }: { data: { login?: string } }) => <div data-testid="profile">{data.login}</div>,
}));

import { Route } from './$id';

const Comp = Route.component as () => JSX.Element;

let fetchImpl: (url: string) => { status?: number; ok: boolean; body: unknown };
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = fetchImpl(url);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as unknown as Response;
  }));
}

function renderProfile(id = '42') {
  paramsVal = { id };
  return render(<Comp />);
}

beforeEach(() => {
  fetchImpl = () => ({ ok: true, body: { profile: { login: 'ada' } } });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/users/github/$id profile route', () => {
  it('rejects a non-numeric id without fetching', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    renderProfile('abc');
    expect(screen.getByText(/Invalid user id: abc/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a non-positive id without fetching', () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    renderProfile('0');
    expect(screen.getByText(/Invalid user id: 0/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('renders the loading state before data arrives', () => {
    renderProfile('42');
    expect(screen.getByText(/Loading profile/i)).toBeTruthy();
  });

  it('renders UserProfile once the payload loads', async () => {
    fetchImpl = () => ({ ok: true, body: { profile: { login: 'octocat' } } });
    renderProfile('42');
    expect(await screen.findByTestId('profile')).toBeTruthy();
    expect(screen.getByTestId('profile').textContent).toBe('octocat');
  });

  it('surfaces a non-ok HTTP error', async () => {
    fetchImpl = () => ({ ok: false, status: 503, body: {} });
    renderProfile('42');
    expect(await screen.findByText(/Could not load profile: HTTP 503/i)).toBeTruthy();
  });

  it('surfaces a resolved body that carries no profile', async () => {
    fetchImpl = () => ({ ok: true, body: { error: 'gone' } });
    renderProfile('42');
    expect(await screen.findByText(/Could not load profile: gone/i)).toBeTruthy();
  });

  it('surfaces a fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    renderProfile('42');
    expect(await screen.findByText(/Could not load profile: boom/i)).toBeTruthy();
  });
});
