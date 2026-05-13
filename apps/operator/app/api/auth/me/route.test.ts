/**
 * /api/auth/me — verify the no-cookie fall-through to the seeded
 * default user. Locks the contract that UserPicker + AutoLoginWelcomeToast
 * rely on: when there's no session cookie, /me still returns a user
 * (the auto-login default) with `autoLogin: true`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/server's NextResponse + the auth lib BEFORE importing route.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
      ...init,
    }),
  },
}));

const defaultUser = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'default',
  display_name: 'User',
  has_password: false,
};
const sessionUser = {
  id: 'abcdef12-0000-0000-0000-000000000099',
  username: 'aviyn',
  display_name: 'Aviyn',
  has_password: true,
};

vi.mock('@/lib/auth', () => ({
  getSessionUser: vi.fn(),
  getSessionUserOrDefault: vi.fn(),
  listUsers: vi.fn(async () => [defaultUser, sessionUser]),
  updateDisplayName: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/auth/me', () => {
  it('falls through to default user when no cookie is present (autoLogin:true)', async () => {
    const auth = await import('@/lib/auth');
    (auth.getSessionUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (auth.getSessionUserOrDefault as ReturnType<typeof vi.fn>).mockResolvedValue(defaultUser);

    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.user).toEqual(defaultUser);
    expect(j.autoLogin).toBe(true);
    expect(Array.isArray(j.available)).toBe(true);
    expect(j.available).toHaveLength(2);
  });

  it('returns explicit session user when cookie is present (autoLogin:false)', async () => {
    const auth = await import('@/lib/auth');
    (auth.getSessionUser as ReturnType<typeof vi.fn>).mockResolvedValue(sessionUser);

    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.user).toEqual(sessionUser);
    expect(j.autoLogin).toBe(false);
    // getSessionUserOrDefault should NOT be called when there's a real session
    expect(auth.getSessionUserOrDefault).not.toHaveBeenCalled();
  });
});
