import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', () => ({
  getSessionUser: vi.fn(),
  getSessionUserOrDefault: vi.fn(),
}));
import { getSessionUser, getSessionUserOrDefault } from '../auth';
import { getSessionUserOrLocalDefault } from './session-or-local';

const user = (id: string) => ({
  id,
  username: 'u',
  display_name: 'U',
  has_password: false,
  workspace_id: 'ws-session',
  capabilities: ['*'],
});

/** The helper only reads req.headers — a headers-bearing stub suffices. */
function reqWithHost(host: string | null): Request {
  const headers = new Headers();
  if (host) headers.set('host', host);
  return { headers } as unknown as Request;
}

describe('getSessionUserOrLocalDefault (WI-5044)', () => {
  beforeEach(() => {
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUserOrDefault).mockReset();
  });

  it('returns the session user when a session cookie resolves', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('real'));
    const got = await getSessionUserOrLocalDefault(reqWithHost('example.com'));
    expect(got?.id).toBe('real');
    expect(getSessionUserOrDefault).not.toHaveBeenCalled();
  });

  it('falls back to the seeded default user for a LOOPBACK caller with no session (the desktop webview)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue(user('default'));
    for (const host of ['127.0.0.1:33700', 'localhost:3270', 'tauri.localhost', '[::1]:3070']) {
      const got = await getSessionUserOrLocalDefault(reqWithHost(host));
      expect(got?.id, host).toBe('default');
    }
  });

  it('stays strict-session for a NON-loopback caller (no perimeter change)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue(user('default'));
    for (const host of ['192.168.1.20:3070', 'evil.example.com', null]) {
      const got = await getSessionUserOrLocalDefault(reqWithHost(host));
      expect(got, String(host)).toBeNull();
    }
    expect(getSessionUserOrDefault).not.toHaveBeenCalled();
  });

  it('degrades to null (401) when both resolutions fail', async () => {
    vi.mocked(getSessionUser).mockRejectedValue(new Error('pg down'));
    vi.mocked(getSessionUserOrDefault).mockRejectedValue(new Error('pg down'));
    const got = await getSessionUserOrLocalDefault(reqWithHost('127.0.0.1:3070'));
    expect(got).toBeNull();
  });
});
