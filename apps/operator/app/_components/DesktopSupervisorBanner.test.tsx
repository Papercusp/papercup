// @vitest-environment jsdom
/**
 * DesktopSupervisorBanner.test.tsx — WI-5392.
 *
 * The component under test exists because the Rust supervisor's `operator-dead`
 * and `install-broken` webview events had NO listener anywhere in the tree, so
 * these tests pin the behaviours that made the banner worth adding: that both
 * events actually render, that the terminal install defect can never be
 * downgraded to the wait-it-out wording, that a recovered transport clears the
 * retrying banner but NOT the install one, and that web (non-desktop) mode and
 * teardown stay clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const isDesktop = vi.fn(() => true);
vi.mock('@papercusp/operator-core/lib/version-tauri', () => ({
  isDesktop: () => isDesktop(),
}));

// Capture each registered listener by event name so a test can fire a
// synthetic supervisor event, plus a spy unlisten to assert teardown.
type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();
const unlistenSpy = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return unlistenSpy;
  }),
}));

let offlineState = true; // start offline: a live operator would clear `dead`
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncConnectivity: () => ({ offline: offlineState }),
}));

import { DesktopSupervisorBanner } from './DesktopSupervisorBanner';

/** Render + flush the dynamic import()/await chain that registers listeners. */
async function mount() {
  const utils = render(<DesktopSupervisorBanner />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return utils;
}

async function fire(event: string, payload: unknown) {
  await act(async () => { listeners.get(event)?.({ payload }); });
}

const DEAD = { reason: 'serve.mjs child', respawns: 5, window_secs: 300 };

beforeEach(() => {
  listeners.clear();
  unlistenSpy.mockClear();
  isDesktop.mockReturnValue(true);
  offlineState = true;
});
afterEach(cleanup);

describe('DesktopSupervisorBanner', () => {
  it('renders nothing until a supervisor event arrives', async () => {
    await mount();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('registers listeners for BOTH supervisor events', async () => {
    await mount();
    expect([...listeners.keys()].sort()).toEqual(['install-broken', 'operator-dead']);
  });

  it('renders the retrying banner on operator-dead, with the respawn detail', async () => {
    await mount();
    await fire('operator-dead', DEAD);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('stopped responding');
    expect(alert.textContent).toContain('5 failed attempts in 300s');
    expect(alert.textContent).toContain('serve.mjs child');
    // Waiting is the right advice here — retries genuinely continue.
    expect(alert.textContent).toContain('Retries continue in the background');
  });

  it('renders the reinstall banner on install-broken and never says "retrying"', async () => {
    await mount();
    await fire('install-broken', 'The sidecar folder is missing.');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('installation is incomplete');
    expect(alert.textContent).toContain('The sidecar folder is missing.');
    expect(alert.textContent).toContain('Reinstall Papercusp');
    expect(alert.textContent).not.toContain('Retries continue');
  });

  it('LATCHES install-broken: a later operator-dead cannot downgrade it', async () => {
    // The real ordering on a broken install — the install defect is detected,
    // and the supervisor may still give up on respawns afterwards. Showing
    // "retries continue" then would tell the user to wait for a recovery that
    // is impossible.
    await mount();
    await fire('install-broken', 'The sidecar folder is missing.');
    await fire('operator-dead', DEAD);
    expect(screen.getByRole('alert').textContent).toContain('Reinstall Papercusp');
    expect(screen.getByRole('alert').textContent).not.toContain('Retries continue');
  });

  it('install-broken takes precedence when it arrives SECOND too', async () => {
    await mount();
    await fire('operator-dead', DEAD);
    await fire('install-broken', 'The sidecar folder is missing.');
    expect(screen.getByRole('alert').textContent).toContain('Reinstall Papercusp');
  });

  it('is not dismissable — no close control is rendered', async () => {
    await mount();
    await fire('operator-dead', DEAD);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('clears the retrying banner once the transport comes back', async () => {
    const { rerender } = await mount();
    await fire('operator-dead', DEAD);
    expect(screen.queryByRole('alert')).not.toBeNull();
    offlineState = false; // operator answered ⇒ a respawn since succeeded
    await act(async () => { rerender(<DesktopSupervisorBanner />); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('survives an operator-dead that lands while the transport still reads ONLINE', async () => {
    // The race the `sawOffline` gate exists for: Rust emits operator-dead the
    // instant the supervisor gives up, which can precede useSyncConnectivity
    // noticing the drop. A bare `!offline` clear would wipe the banner on the
    // next render and the user would never see it.
    offlineState = false;
    const { rerender } = await mount();
    await fire('operator-dead', DEAD);
    await act(async () => { rerender(<DesktopSupervisorBanner />); });
    expect(screen.getByRole('alert').textContent).toContain('stopped responding');

    // Now the real drop is observed, and only a LATER recovery clears it.
    offlineState = true;
    await act(async () => { rerender(<DesktopSupervisorBanner />); });
    expect(screen.queryByRole('alert')).not.toBeNull();
    offlineState = false;
    await act(async () => { rerender(<DesktopSupervisorBanner />); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does NOT clear the install banner when the transport looks healthy', async () => {
    const { rerender } = await mount();
    await fire('install-broken', 'The sidecar folder is missing.');
    offlineState = false;
    await act(async () => { rerender(<DesktopSupervisorBanner />); });
    expect(screen.getByRole('alert').textContent).toContain('Reinstall Papercusp');
  });

  it('renders nothing and registers no listeners in web (non-desktop) mode', async () => {
    isDesktop.mockReturnValue(false);
    await mount();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it('unlistens both events on unmount', async () => {
    const { unmount } = await mount();
    unmount();
    expect(unlistenSpy).toHaveBeenCalledTimes(2);
  });
});
