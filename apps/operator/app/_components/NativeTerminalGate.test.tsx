// @vitest-environment jsdom
// D-004 (operator-chat-sidebar-revival-2026-07-13 P-014/P-015): the webview
// side of the native-dock TESTING gate. Rust no longer spawns the dock at
// boot; NativeTerminalGate is the ONLY thing that opens the gate, by relaying
// the resolved FLAGS.TESTING to `native_terminal_set_enabled`. These tests
// pin the relay contract: flag off ⇒ relay false (dock stays dark — the
// shipped default), flag on ⇒ relay true, live flip ⇒ re-relay, non-Tauri ⇒
// no invoke at all.
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  testingFlag: false,
  desktopAllowed: true,
  setEnabledSpy: vi.fn(() => Promise.resolve({ status: 'ok', data: false })),
}));

vi.mock('@papercusp/operator-core/lib/tauri-bindings', () => ({
  commands: { nativeTerminalSetEnabled: h.setEnabledSpy },
}));
vi.mock('@/lib/ipc-status-tauri', () => ({ canUseContentOriginDesktopActions: async () => h.desktopAllowed }));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => h.testingFlag }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { TESTING: 'papercusp-testing' } }));

import NativeTerminalGate from './NativeTerminalGate';

describe('NativeTerminalGate (D-004: dock is TESTING-gated)', () => {
  beforeEach(() => {
    h.testingFlag = false;
    h.desktopAllowed = true;
    h.setEnabledSpy.mockClear();
  });
  afterEach(() => cleanup());

  it('relays false when FLAGS.TESTING is off (the shipped default — dock stays dark)', async () => {
    render(<NativeTerminalGate />);
    await waitFor(() => expect(h.setEnabledSpy).toHaveBeenCalledWith(false));
    expect(h.setEnabledSpy).toHaveBeenCalledTimes(1);
  });

  it('relays true when FLAGS.TESTING is on (dev path — dock spawns)', async () => {
    h.testingFlag = true;
    render(<NativeTerminalGate />);
    await waitFor(() => expect(h.setEnabledSpy).toHaveBeenCalledWith(true));
  });

  it('re-relays on a live flag flip (rerender with the new value)', async () => {
    const { rerender } = render(<NativeTerminalGate />);
    await waitFor(() => expect(h.setEnabledSpy).toHaveBeenCalledWith(false));
    h.testingFlag = true;
    rerender(<NativeTerminalGate />);
    await waitFor(() => expect(h.setEnabledSpy).toHaveBeenCalledWith(true));
    expect(h.setEnabledSpy).toHaveBeenCalledTimes(2);
  });

  it('never invokes outside the Tauri webview', async () => {
    h.desktopAllowed = false;
    render(<NativeTerminalGate />);
    // Give any (wrong) effect a beat to fire before asserting silence.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.setEnabledSpy).not.toHaveBeenCalled();
  });

  it('renders nothing (a pure seam relay, no UI)', () => {
    const { container } = render(<NativeTerminalGate />);
    expect(container.innerHTML).toBe('');
  });

  it('a relay error is non-fatal (warns, does not throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.setEnabledSpy.mockResolvedValueOnce({
      status: 'error',
      error: 'old binary without the command',
    } as never);
    render(<NativeTerminalGate />);
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    warnSpy.mockRestore();
  });
});
