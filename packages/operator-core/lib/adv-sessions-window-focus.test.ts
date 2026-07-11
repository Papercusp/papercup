/**
 * Coverage for adv-sessions.ts's Windows-desktop-host branch of
 * resolveWindowIdForTitleFragment / focusWindowId
 * (windows-desktop-feature-parity-2026-07-02 P-010).
 *
 * On Windows there is no pid→window mapping across the WSL boundary, so
 * these two functions delegate to windows-desktop-windows.ts's title-based
 * helpers instead of shelling out to `wmctrl`. windows-desktop-windows.ts is
 * mocked here — its own hermetic coverage lives in
 * windows-desktop-windows.test.ts.
 *
 * Gated on `isWindowsDesktopHost()`, NOT `process.platform` — the operator
 * always runs as a `wsl.exe --exec node` Linux process (main.rs), so
 * `process.platform` reports 'linux' even on a real Windows box (P-025 audit
 * finding, WI-1646's sibling). Mock the host-detection function directly
 * rather than overriding process.platform.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const listWindowsByTitleMock = vi.fn();
const focusWindowByTitleMock = vi.fn();
const isWindowsDesktopHostMock = vi.fn(() => false);

vi.mock('./windows-desktop-windows', () => ({
  listWindowsByTitle: (...args: unknown[]) => listWindowsByTitleMock(...args),
  focusWindowByTitle: (...args: unknown[]) => focusWindowByTitleMock(...args),
  isWindowsDesktopHost: () => isWindowsDesktopHostMock(),
}));

afterEach(() => {
  vi.clearAllMocks();
  isWindowsDesktopHostMock.mockReturnValue(false);
});

describe('resolveWindowIdForTitleFragment — Windows-desktop-host branch', () => {
  it('returns the matching window\'s exact TITLE (not an hwnd) on a hit', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    listWindowsByTitleMock.mockResolvedValueOnce([
      { hwnd: '0x1', pid: 111, title: 'Untitled - Notepad' },
      { hwnd: '0x2', pid: 222, title: 'Papercup — abc-123' },
    ]);
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    const wid = await resolveWindowIdForTitleFragment('abc-123');
    expect(wid).toBe('Papercup — abc-123');
  });

  it('returns null when no window title contains the fragment', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    listWindowsByTitleMock.mockResolvedValueOnce([{ hwnd: '0x1', pid: 111, title: 'Untitled - Notepad' }]);
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    expect(await resolveWindowIdForTitleFragment('abc-123')).toBeNull();
  });

  it('fails soft to null if the helper throws', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    listWindowsByTitleMock.mockRejectedValueOnce(new Error('powershell exploded'));
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    expect(await resolveWindowIdForTitleFragment('abc-123')).toBeNull();
  });

  it('never calls the Windows helper off a Windows-desktop host (wmctrl path taken instead)', async () => {
    isWindowsDesktopHostMock.mockReturnValue(false);
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    await resolveWindowIdForTitleFragment('some-fragment-unlikely-to-be-a-real-window');
    expect(listWindowsByTitleMock).not.toHaveBeenCalled();
  });
});

describe('focusWindowId — Windows-desktop-host branch', () => {
  it('treats windowId as a TITLE and delegates to focusWindowByTitle', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    focusWindowByTitleMock.mockResolvedValueOnce(true);
    const { focusWindowId } = await import('./adv-sessions');
    const ok = await focusWindowId('Papercup — abc-123');
    expect(ok).toBe(true);
    expect(focusWindowByTitleMock).toHaveBeenCalledWith('Papercup — abc-123');
  });

  it('fails soft to false if the helper throws', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    focusWindowByTitleMock.mockRejectedValueOnce(new Error('powershell exploded'));
    const { focusWindowId } = await import('./adv-sessions');
    expect(await focusWindowId('Papercup — abc-123')).toBe(false);
  });

  it('never calls the Windows helper off a Windows-desktop host (wmctrl path taken instead)', async () => {
    isWindowsDesktopHostMock.mockReturnValue(false);
    const { focusWindowId } = await import('./adv-sessions');
    await focusWindowId('0x123');
    expect(focusWindowByTitleMock).not.toHaveBeenCalled();
  });
});

describe('closeWindowId — the "Kill agent" window close (owner ask 2026-07-11)', () => {
  it('returns false (un-actionable) on a Windows-desktop host — no safe title-based close yet', async () => {
    isWindowsDesktopHostMock.mockReturnValue(true);
    const { closeWindowId } = await import('./adv-sessions');
    // Must NOT fall through to focusing/closing the wrong window by title.
    expect(await closeWindowId('Papercup — abc-123')).toBe(false);
    expect(focusWindowByTitleMock).not.toHaveBeenCalled();
  });

  it('off a Windows-desktop host takes the wmctrl path (never the Windows title helper)', async () => {
    isWindowsDesktopHostMock.mockReturnValue(false);
    const { closeWindowId } = await import('./adv-sessions');
    // Shells to `wmctrl -ic <wid>`; returns a boolean from the exit status. On a
    // host without wmctrl/DISPLAY it fails soft to false — never throws, and
    // never touches the Windows helper.
    const r = await closeWindowId('0x123');
    expect(typeof r).toBe('boolean');
    expect(focusWindowByTitleMock).not.toHaveBeenCalled();
  });
});
