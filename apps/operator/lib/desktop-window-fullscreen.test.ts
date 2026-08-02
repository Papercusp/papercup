// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The contract these tests exist to hold is OWNERSHIP and SOFT-FAIL — the two
 * places this module can go wrong in a way the UI cannot detect:
 *   - un-fullscreening a window the user fullscreened themselves;
 *   - throwing on a desktop binary whose baked ACL predates
 *     `core:window:allow-set-fullscreen`, which would turn a fallback into a
 *     dead control.
 * `@tauri-apps/api/window` is dynamically imported by the module under test, so
 * each case mocks it and re-imports with a fresh module registry.
 */

const setFullscreen = vi.fn();
const isFullscreen = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setFullscreen: (v: boolean) => setFullscreen(v),
    isFullscreen: () => isFullscreen(),
  }),
}));

function markDesktop(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

async function load() {
  vi.resetModules();
  return import('./desktop-window-fullscreen');
}

afterEach(() => {
  markDesktop(false);
  setFullscreen.mockReset();
  isFullscreen.mockReset();
});

describe('isDesktopShell', () => {
  it('is false in a plain browser and true under the Tauri shell', async () => {
    const m = await load();
    expect(m.isDesktopShell()).toBe(false);
    markDesktop(true);
    expect(m.isDesktopShell()).toBe(true);
  });
});

describe('enterDesktopWindowFullscreen', () => {
  it('does nothing in a browser — the caller keeps the DOM Fullscreen path', async () => {
    const m = await load();
    await expect(m.enterDesktopWindowFullscreen()).resolves.toEqual({ active: false, owned: false });
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it('fullscreens the window and claims ownership', async () => {
    markDesktop(true);
    isFullscreen.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const m = await load();
    await expect(m.enterDesktopWindowFullscreen()).resolves.toEqual({ active: true, owned: true });
    expect(setFullscreen).toHaveBeenCalledWith(true);
  });

  it('ADOPTS an already-fullscreen window without claiming it — the user got there first', async () => {
    markDesktop(true);
    isFullscreen.mockResolvedValue(true);
    const m = await load();
    // active, so the caller shows the maximized layout…
    await expect(m.enterDesktopWindowFullscreen()).resolves.toEqual({ active: true, owned: false });
    // …but the window was never touched, so exiting cannot take away a
    // fullscreen the user set for themselves.
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it('reports inactive when the window did not actually move (capability not baked in)', async () => {
    markDesktop(true);
    // The classic shape of a denied ACL: the invoke resolves, the window does
    // not change. Trusting the call rather than the window would leave the UI
    // claiming full screen over an unchanged window.
    isFullscreen.mockResolvedValue(false);
    setFullscreen.mockResolvedValue(undefined);
    const m = await load();
    await expect(m.enterDesktopWindowFullscreen()).resolves.toEqual({ active: false, owned: false });
  });

  it('soft-fails on a rejected call rather than throwing at the click handler', async () => {
    markDesktop(true);
    isFullscreen.mockResolvedValueOnce(false);
    setFullscreen.mockRejectedValueOnce(new Error('window.set_fullscreen not allowed'));
    const m = await load();
    await expect(m.enterDesktopWindowFullscreen()).resolves.toEqual({ active: false, owned: false });
  });
});

describe('exitDesktopWindowFullscreen', () => {
  it('puts the window back', async () => {
    markDesktop(true);
    setFullscreen.mockResolvedValue(undefined);
    const m = await load();
    await m.exitDesktopWindowFullscreen();
    expect(setFullscreen).toHaveBeenCalledWith(false);
  });

  it('is a no-op in a browser, and swallows a refusal', async () => {
    const browser = await load();
    await browser.exitDesktopWindowFullscreen();
    expect(setFullscreen).not.toHaveBeenCalled();

    markDesktop(true);
    setFullscreen.mockRejectedValueOnce(new Error('nope'));
    const desktop = await load();
    await expect(desktop.exitDesktopWindowFullscreen()).resolves.toBeUndefined();
  });
});

describe('isDesktopWindowFullscreen', () => {
  it('reads the window, and answers false when there is none', async () => {
    const browser = await load();
    await expect(browser.isDesktopWindowFullscreen()).resolves.toBe(false);

    markDesktop(true);
    isFullscreen.mockResolvedValue(true);
    const desktop = await load();
    await expect(desktop.isDesktopWindowFullscreen()).resolves.toBe(true);
  });
});
