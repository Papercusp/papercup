/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigateClient = vi.fn();
const fetchMock = vi.fn();

vi.mock('../client-navigation', () => ({
  navigateClient: (...args: unknown[]) => navigateClient(...args),
}));

vi.mock('../tauri-bindings', () => ({
  commands: {
    workspacesList: vi.fn(),
    workspacesCreate: vi.fn(),
    workspacesRename: vi.fn(),
    workspacesDelete: vi.fn(),
    workspacesSwitch: vi.fn(),
  },
}));

afterEach(() => {
  navigateClient.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('workspaces-tauri', () => {
  it('builds the default workspace reset path', async () => {
    const { resolveWorkspaceSwitchTarget } = await import('../workspaces-tauri');
    expect(resolveWorkspaceSwitchTarget('alpha')).toBe('/harness?ws=alpha');
    expect(resolveWorkspaceSwitchTarget('alpha', { resetTo: '/support?ws=alpha' })).toBe('/support?ws=alpha');
  });

  it('soft-navigates on the web/static path after a successful workspace switch', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
    const { switchWorkspace } = await import('../workspaces-tauri');

    await switchWorkspace('beta', { resetTo: '/harness?ws=beta&panel=overview' });

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/switch', expect.objectContaining({ method: 'POST' }));
    expect(navigateClient).toHaveBeenCalledWith('/harness?ws=beta&panel=overview');
  });
});
