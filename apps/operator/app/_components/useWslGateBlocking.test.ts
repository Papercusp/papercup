// @vitest-environment jsdom
/**
 * useWslGateBlocking.test.ts — WI-2749 item #2.
 *
 * Verifies the hook mirrors WslOnboardingGate's "is the overlay showing"
 * condition (blocking on any state other than NotSupported/Ready, not
 * blocking on null/thrown), and — critically — that it NEVER calls any of
 * the WSL side-effecting commands (install/import/bootstrap/finalize):
 * WslOnboardingGate is the sole owner of those one-shot flows, and a
 * second component polling the same status must stay read-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

const isTauri = vi.fn(() => true);
const wslStatus = vi.fn(async () => null as unknown);
const wslInstall = vi.fn(async () => {});
const wslImport = vi.fn(async () => {});
const wslBootstrap = vi.fn(async () => '');
const wslFinalizeReady = vi.fn(async () => {});

vi.mock('@papercusp/operator-core/lib/wsl-tauri', () => ({
  isTauri: () => isTauri(),
  wslStatus: () => wslStatus(),
  wslInstall: () => wslInstall(),
  wslImport: () => wslImport(),
  wslBootstrap: () => wslBootstrap(),
  wslFinalizeReady: () => wslFinalizeReady(),
}));

import { useWslGateBlocking } from './useWslGateBlocking';

function mkStatus(kind: string) {
  return { state: { kind }, wslExeAvailable: true, distros: [], defaultVersion: 2 };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  isTauri.mockReturnValue(true);
  wslStatus.mockResolvedValue(null);
  wslInstall.mockClear();
  wslImport.mockClear();
  wslBootstrap.mockClear();
  wslFinalizeReady.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useWslGateBlocking', () => {
  it('is false when not running in Tauri', async () => {
    isTauri.mockReturnValue(false);
    const { result } = renderHook(() => useWslGateBlocking());
    expect(result.current).toBe(false);
  });

  it('is false when wsl_status resolves null (ACL-denied / non-dev origin)', async () => {
    wslStatus.mockResolvedValue(null);
    const { result } = renderHook(() => useWslGateBlocking());
    await waitFor(() => expect(wslStatus).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('fails safe to false when wsl_status throws', async () => {
    wslStatus.mockRejectedValue(new Error('denied'));
    const { result } = renderHook(() => useWslGateBlocking());
    await waitFor(() => expect(wslStatus).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('is false on NotSupported and Ready', async () => {
    wslStatus.mockResolvedValue(mkStatus('NotSupported'));
    const { result, rerender } = renderHook(() => useWslGateBlocking());
    await waitFor(() => expect(result.current).toBe(false));

    wslStatus.mockResolvedValue(mkStatus('Ready'));
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current).toBe(false);
  });

  it('is true on every onboarding-in-progress state', async () => {
    for (const kind of ['NotInstalled', 'PendingReboot', 'InstalledNoDistro', 'PendingBootstrap', 'Error']) {
      wslStatus.mockResolvedValue(mkStatus(kind));
      const { result } = renderHook(() => useWslGateBlocking());
      await waitFor(() => expect(result.current).toBe(true));
      cleanup();
    }
  });

  it('never triggers install/import/bootstrap/finalize side effects', async () => {
    wslStatus.mockResolvedValue(mkStatus('PendingBootstrap'));
    const { result } = renderHook(() => useWslGateBlocking());
    await waitFor(() => expect(result.current).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500 * 3);
    });
    expect(wslInstall).not.toHaveBeenCalled();
    expect(wslImport).not.toHaveBeenCalled();
    expect(wslBootstrap).not.toHaveBeenCalled();
    expect(wslFinalizeReady).not.toHaveBeenCalled();
  });
});
