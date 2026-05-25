/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigateClient = vi.fn();
const fetchMock = vi.fn();

vi.mock('../client-navigation', () => ({
  navigateClient: (...args: unknown[]) => navigateClient(...args),
}));

const commands = {
  workspacesList: vi.fn(),
  workspacesCreate: vi.fn(),
  workspacesRename: vi.fn(),
  workspacesDelete: vi.fn(),
  workspacesSwitch: vi.fn(),
};

vi.mock('../tauri-bindings', () => ({
  commands,
}));

afterEach(() => {
  navigateClient.mockReset();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  commands.workspacesList.mockReset();
  commands.workspacesCreate.mockReset();
  commands.workspacesRename.mockReset();
  commands.workspacesDelete.mockReset();
  commands.workspacesSwitch.mockReset();
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
  it('uses the desktop command path without soft navigation when Tauri is present', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesSwitch.mockResolvedValue({ status: 'ok' });
    const { switchWorkspace } = await import('../workspaces-tauri');

    await switchWorkspace('gamma', { resetTo: '/harness?ws=gamma' });

    expect(commands.workspacesSwitch).toHaveBeenCalledWith('gamma');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigateClient).not.toHaveBeenCalled();
  });

  it('surfaces desktop command errors', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesSwitch.mockResolvedValue({ status: 'error', error: 'boom' });
    const { switchWorkspace } = await import('../workspaces-tauri');

    await expect(switchWorkspace('gamma')).rejects.toThrow('boom');
    expect(navigateClient).not.toHaveBeenCalled();
  });
  it('lists workspaces through the desktop command path when Tauri is present', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesList.mockResolvedValue({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] });
    const { listWorkspaces } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).resolves.toEqual({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates, renames, and deletes workspaces through the desktop command path when Tauri is present', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesCreate.mockResolvedValue({ status: 'ok', data: { id: 'beta', name: 'Beta' } });
    commands.workspacesRename.mockResolvedValue({ status: 'ok' });
    commands.workspacesDelete.mockResolvedValue({ status: 'ok' });
    const { createWorkspace, renameWorkspace, deleteWorkspace } = await import('../workspaces-tauri');

    await expect(createWorkspace('Beta')).resolves.toEqual({ id: 'beta', name: 'Beta' });
    await expect(renameWorkspace('beta', 'Beta 2')).resolves.toBeUndefined();
    await expect(deleteWorkspace('beta')).resolves.toBeUndefined();

    expect(commands.workspacesCreate).toHaveBeenCalledWith('Beta');
    expect(commands.workspacesRename).toHaveBeenCalledWith('beta', 'Beta 2');
    expect(commands.workspacesDelete).toHaveBeenCalledWith('beta');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces desktop command errors for list/create/rename/delete', async () => {
    vi.stubGlobal('window', { ...window, __TAURI_INTERNALS__: {} });
    commands.workspacesList.mockRejectedValue(new Error('list-fail'));
    commands.workspacesCreate.mockResolvedValue({ status: 'error', error: 'create-fail' });
    commands.workspacesRename.mockResolvedValue({ status: 'error', error: 'rename-fail' });
    commands.workspacesDelete.mockResolvedValue({ status: 'error', error: 'delete-fail' });
    const {
      listWorkspaces,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
    } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).rejects.toThrow('list-fail');
    await expect(createWorkspace('Beta')).rejects.toThrow('create-fail');
    await expect(renameWorkspace('beta', 'Beta 2')).rejects.toThrow('rename-fail');
    await expect(deleteWorkspace('beta')).rejects.toThrow('delete-fail');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigateClient).not.toHaveBeenCalled();
  });

  it('uses fetch on the web/static path for list/create/rename/delete', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: 'beta', name: 'Beta' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const {
      listWorkspaces,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
    } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).resolves.toEqual({ current: 'alpha', workspaces: [{ id: 'alpha', name: 'Alpha' }] });
    await expect(createWorkspace('Beta')).resolves.toEqual({ id: 'beta', name: 'Beta' });
    await expect(renameWorkspace('beta', 'Beta 2')).resolves.toBeUndefined();
    await expect(deleteWorkspace('beta')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({
      cache: 'no-store',
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/beta', expect.objectContaining({
      method: 'PATCH',
      cache: 'no-store',
    }));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/beta', expect.objectContaining({
      method: 'DELETE',
      cache: 'no-store',
    }));
    expect(navigateClient).not.toHaveBeenCalled();
  });

  it('surfaces web/static path fetch failures', async () => {
    vi.stubGlobal('fetch', fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    const {
      listWorkspaces,
      createWorkspace,
      renameWorkspace,
      deleteWorkspace,
    } = await import('../workspaces-tauri');

    await expect(listWorkspaces()).rejects.toThrow('boom');
    await expect(createWorkspace('Beta')).rejects.toThrow('boom');
    await expect(renameWorkspace('beta', 'Beta 2')).rejects.toThrow('boom');
    await expect(deleteWorkspace('beta')).rejects.toThrow('boom');
  });
});
