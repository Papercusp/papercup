/**
 * Coverage for version-tauri: the desktop-runtime guard (web mode returns
 * nulls / no-ops) and the Specta error-envelope unwrap. The tauri-bindings
 * commands are mocked; window.__TAURI_INTERNALS__ is stubbed for desktop mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { commands } = vi.hoisted(() => ({
  commands: {
    appVersion: vi.fn(),
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(),
    revertTo: vi.fn(),
  },
}));
vi.mock('./tauri-bindings', () => ({ commands }));

import { isDesktop, appVersion, checkForUpdate, installUpdate, revertTo } from './version-tauri';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const enterDesktop = () => vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });

describe('web mode (no Tauri internals)', () => {
  it('isDesktop is false and version/update reads are null/no-op', async () => {
    expect(isDesktop()).toBe(false);
    expect(await appVersion()).toBeNull();
    expect(await checkForUpdate()).toBeNull();
    await expect(installUpdate()).rejects.toThrow(/not in desktop mode/);
    await expect(revertTo('desktop-v1.0.0')).rejects.toThrow(/not in desktop mode/);
    expect(commands.appVersion).not.toHaveBeenCalled();
    expect(commands.revertTo).not.toHaveBeenCalled();
  });
});

describe('desktop mode', () => {
  it('isDesktop true; appVersion delegates to the binding', async () => {
    enterDesktop();
    commands.appVersion.mockResolvedValue('1.2.3');
    expect(isDesktop()).toBe(true);
    expect(await appVersion()).toBe('1.2.3');
  });

  it('checkForUpdate returns the data on an ok envelope', async () => {
    enterDesktop();
    commands.checkForUpdate.mockResolvedValue({ status: 'ok', data: { available: true, version: '2.0.0' } });
    expect(await checkForUpdate()).toEqual({ available: true, version: '2.0.0' });
  });

  it('checkForUpdate throws on an error envelope', async () => {
    enterDesktop();
    commands.checkForUpdate.mockResolvedValue({ status: 'error', error: 'update server down' });
    await expect(checkForUpdate()).rejects.toThrow('update server down');
  });

  it('installUpdate resolves on ok, throws on error envelope', async () => {
    enterDesktop();
    commands.installUpdate.mockResolvedValue({ status: 'ok' });
    await expect(installUpdate()).resolves.toBeUndefined();
    commands.installUpdate.mockResolvedValue({ status: 'error', error: 'patch failed' });
    await expect(installUpdate()).rejects.toThrow('patch failed');
  });

  it('revertTo passes the tag through and unwraps the envelope', async () => {
    enterDesktop();
    commands.revertTo.mockResolvedValue({ status: 'ok' });
    await expect(revertTo('desktop-v1.0.0')).resolves.toBeUndefined();
    expect(commands.revertTo).toHaveBeenCalledWith('desktop-v1.0.0');
    commands.revertTo.mockResolvedValue({ status: 'error', error: 'unknown_tag' });
    await expect(revertTo('desktop-v9.9.9')).rejects.toThrow('unknown_tag');
  });
});
