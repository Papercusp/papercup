/**
 * Unit tests for `principalFromCookie` — the cookie-session resolver
 * INTERNALS.
 *
 * The composite `require-principal.test.ts` only asserts the cookie path
 * wins the fall-through. This file pins the resolver body:
 *   - no session (getSessionUser → null) → null;
 *   - a valid session → a verified `kind: 'user'` principal;
 *   - label precedence (display_name over username, falls back to username).
 *
 * Hermetic: `getSessionUser` (the only PG-touching dep — it calls getOrgPg
 * internally) and `activeWorkspaceId` are mocked, so nothing hits PG.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../auth';

vi.mock('../../auth', () => ({
  getSessionUser: vi.fn(async () => null),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-active'),
}));

import { principalFromCookie } from './from-cookie';
import { getSessionUser } from '../../auth';
import { activeWorkspaceId } from '../../workspace-registry';

const h = (init: Record<string, string> = {}) => new Headers(init);

const user = (over: Partial<User> = {}): User => ({
  id: 'user_1',
  username: 'alice',
  display_name: 'Alice',
  has_password: true,
  ...over,
});

beforeEach(() => {
  vi.mocked(getSessionUser).mockResolvedValue(null);
  vi.mocked(activeWorkspaceId).mockReturnValue('ws-active');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('principalFromCookie', () => {
  it('returns null when there is no session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect(await principalFromCookie(h())).toBeNull();
  });

  it('passes the request Headers through to getSessionUser', async () => {
    const headers = h({ cookie: 'papercusp_session=abc' });
    await principalFromCookie(headers);
    expect(getSessionUser).toHaveBeenCalledWith(headers);
  });

  it('mints a verified user principal for a valid session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user({ id: 'user_1' }));
    const p = await principalFromCookie(h({ cookie: 'papercusp_session=abc' }));
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      kind: 'user',
      slug: 'user_1',
      workspaceId: 'ws-active',
      authMethod: 'cookie-session',
      trust: 'verified',
      label: 'Alice',
    });
    expect(p!.capabilities).toBeInstanceOf(Set);
    expect(p!.capabilities.has('*')).toBe(true);
  });

  it('uses the active workspace id (cookie sessions are workspace-scoped in v1)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user());
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-scoped');
    const p = await principalFromCookie(h());
    expect(p!.workspaceId).toBe('ws-scoped');
  });

  it('prefers display_name for the label', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(
      user({ username: 'alice', display_name: 'Alice Liddell' }),
    );
    const p = await principalFromCookie(h());
    expect(p!.label).toBe('Alice Liddell');
  });

  it('falls back to username when display_name is empty', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(
      user({ username: 'bob', display_name: '' }),
    );
    const p = await principalFromCookie(h());
    expect(p!.label).toBe('bob');
  });
});
