// @vitest-environment jsdom
/**
 * WslOnboardingGate.test.tsx — render-tier coverage for the WSL2 onboarding
 * gate. The gate wraps the app and intercepts the render when running in the
 * Tauri-on-Windows desktop app with an unfinished WSL2 setup. We mock
 * `wsl-tauri` so each lifecycle kind (NotSupported / Ready / NotInstalled /
 * PendingReboot / Error / InstalledNoDistro / PendingBootstrap) renders its
 * branch, and assert the pass-through vs the wizard branches. The confirm
 * dialog + sonner toast are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const isTauri = vi.fn(() => true);
const wslStatus = vi.fn(async () => null as unknown);
const wslInstall = vi.fn(async () => {});
const wslImport = vi.fn(async () => {});
const wslBootstrap = vi.fn(async () => 'log line\nanother');
const wslUninstall = vi.fn(async () => {});
const wslFinalizeReady = vi.fn(async () => {});
const wslRelaunchElevated = vi.fn(async () => {});

vi.mock('@papercusp/operator-core/lib/wsl-tauri', () => ({
  isTauri: () => isTauri(),
  wslStatus: () => wslStatus(),
  wslInstall: () => wslInstall(),
  wslImport: () => wslImport(),
  wslBootstrap: () => wslBootstrap(),
  wslUninstall: () => wslUninstall(),
  wslFinalizeReady: () => wslFinalizeReady(),
  wslRelaunchElevated: () => wslRelaunchElevated(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const askConfirm = vi.fn(async () => true);
vi.mock('../harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ askConfirm, confirmEl: null }),
}));

import WslOnboardingGate from './WslOnboardingGate';

function mkStatus(kind: string, message?: string) {
  return {
    state: message !== undefined ? { kind, message } : { kind },
    wslExeAvailable: true,
    distros: [],
    defaultVersion: 2,
  };
}

beforeEach(() => {
  isTauri.mockReturnValue(true);
  wslStatus.mockResolvedValue(null);
  wslInstall.mockClear();
  wslImport.mockClear();
  wslBootstrap.mockClear();
  askConfirm.mockClear();
});
afterEach(cleanup);

describe('WslOnboardingGate', () => {
  it('passes through to children when not running in Tauri', async () => {
    isTauri.mockReturnValue(false);
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    // Non-Tauri → refresh() sets status to null → children render.
    await waitFor(() => expect(screen.getByText('app body')).toBeTruthy());
    expect(screen.queryByText(/Papercup setup/i)).toBeNull();
  });

  it('passes through to children on NotSupported', async () => {
    wslStatus.mockResolvedValue(mkStatus('NotSupported'));
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    await waitFor(() => expect(screen.getByText('app body')).toBeTruthy());
    expect(screen.queryByText(/Papercup setup/i)).toBeNull();
  });

  it('passes through to children when WSL is Ready', async () => {
    wslStatus.mockResolvedValue(mkStatus('Ready'));
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    await waitFor(() => expect(screen.getByText('app body')).toBeTruthy());
    expect(screen.queryByText(/Papercup setup/i)).toBeNull();
  });

  it('renders the install wizard (not the children) on NotInstalled', async () => {
    wslStatus.mockResolvedValue(mkStatus('NotInstalled'));
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    await waitFor(() => expect(screen.getByText(/Papercup setup/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Install WSL2/i })).toBeTruthy();
    // The wizard gates the app — the children are NOT rendered.
    expect(screen.queryByText('app body')).toBeNull();
  });

  it('renders the reboot step with a Re-check button on PendingReboot', async () => {
    wslStatus.mockResolvedValue(mkStatus('PendingReboot'));
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    await waitFor(() => expect(screen.getByText(/Please reboot Windows/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Re-check/i })).toBeTruthy();
  });

  it('renders the error message + Retry button on Error', async () => {
    wslStatus.mockResolvedValue(mkStatus('Error', 'boom went the setup'));
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    await waitFor(() => expect(screen.getByText(/Setup failed/i)).toBeTruthy());
    // The message appears in the Error step's <pre> AND in the Diagnostics dump.
    expect(screen.getAllByText(/boom went the setup/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });

  it('auto-runs the import (no explicit button) on InstalledNoDistro', async () => {
    wslStatus.mockResolvedValue(mkStatus('InstalledNoDistro'));
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    await waitFor(() => expect(screen.getByText(/Importing papercup runtime/i)).toBeTruthy());
    // The import auto-fires (no user button for this step).
    await waitFor(() => expect(wslImport).toHaveBeenCalled());
  });

  it('auto-runs the bootstrap on PendingBootstrap', async () => {
    wslStatus.mockResolvedValue(mkStatus('PendingBootstrap'));
    render(<WslOnboardingGate><div>app body</div></WslOnboardingGate>);
    await waitFor(() => expect(screen.getByText(/Configuring runtime/i)).toBeTruthy());
    await waitFor(() => expect(wslBootstrap).toHaveBeenCalled());
  });
});
