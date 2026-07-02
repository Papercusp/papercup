/**
 * Coverage for adv-sessions.ts's win32 branch of
 * resolveWindowIdForTitleFragment / focusWindowId
 * (windows-desktop-feature-parity-2026-07-02 P-010).
 *
 * On Windows there is no pid→window mapping across the WSL boundary, so
 * these two functions delegate to windows-desktop-windows.ts's title-based
 * helpers instead of shelling out to `wmctrl`. windows-desktop-windows.ts is
 * mocked here — its own hermetic coverage lives in
 * windows-desktop-windows.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const listWindowsByTitleMock = vi.fn();
const focusWindowByTitleMock = vi.fn();

vi.mock('./windows-desktop-windows', () => ({
  listWindowsByTitle: (...args: unknown[]) => listWindowsByTitleMock(...args),
  focusWindowByTitle: (...args: unknown[]) => focusWindowByTitleMock(...args),
}));

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.clearAllMocks();
});

describe('resolveWindowIdForTitleFragment — win32 branch', () => {
  it('returns the matching window\'s exact TITLE (not an hwnd) on a hit', async () => {
    setPlatform('win32');
    listWindowsByTitleMock.mockResolvedValueOnce([
      { hwnd: '0x1', pid: 111, title: 'Untitled - Notepad' },
      { hwnd: '0x2', pid: 222, title: 'Papercup — abc-123' },
    ]);
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    const wid = await resolveWindowIdForTitleFragment('[adv:5]'.replace('[adv:5]', 'abc-123'));
    expect(wid).toBe('Papercup — abc-123');
  });

  it('returns null when no window title contains the fragment', async () => {
    setPlatform('win32');
    listWindowsByTitleMock.mockResolvedValueOnce([{ hwnd: '0x1', pid: 111, title: 'Untitled - Notepad' }]);
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    expect(await resolveWindowIdForTitleFragment('abc-123')).toBeNull();
  });

  it('fails soft to null if the helper throws', async () => {
    setPlatform('win32');
    listWindowsByTitleMock.mockRejectedValueOnce(new Error('powershell exploded'));
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    expect(await resolveWindowIdForTitleFragment('abc-123')).toBeNull();
  });

  it('never calls the Windows helper on linux (wmctrl path taken instead)', async () => {
    setPlatform('linux');
    const { resolveWindowIdForTitleFragment } = await import('./adv-sessions');
    await resolveWindowIdForTitleFragment('some-fragment-unlikely-to-be-a-real-window');
    expect(listWindowsByTitleMock).not.toHaveBeenCalled();
  });
});

describe('focusWindowId — win32 branch', () => {
  it('treats windowId as a TITLE and delegates to focusWindowByTitle', async () => {
    setPlatform('win32');
    focusWindowByTitleMock.mockResolvedValueOnce(true);
    const { focusWindowId } = await import('./adv-sessions');
    const ok = await focusWindowId('Papercup — abc-123');
    expect(ok).toBe(true);
    expect(focusWindowByTitleMock).toHaveBeenCalledWith('Papercup — abc-123');
  });

  it('fails soft to false if the helper throws', async () => {
    setPlatform('win32');
    focusWindowByTitleMock.mockRejectedValueOnce(new Error('powershell exploded'));
    const { focusWindowId } = await import('./adv-sessions');
    expect(await focusWindowId('Papercup — abc-123')).toBe(false);
  });

  it('never calls the Windows helper on linux (wmctrl path taken instead)', async () => {
    setPlatform('linux');
    const { focusWindowId } = await import('./adv-sessions');
    await focusWindowId('0x123');
    expect(focusWindowByTitleMock).not.toHaveBeenCalled();
  });
});
