// @vitest-environment jsdom
/**
 * UpdateChip.test.tsx — render-tier coverage for the footer version/update chip.
 * Branches: web mode (renders null), desktop-before-version (null), the plain
 * "vX" check chip (no update), and the "Update to vY" install chip + its
 * confirm-then-install flow. `version-tauri` is fully mocked so we drive
 * isDesktop / appVersion / checkForUpdate / installUpdate per case; Tooltip and
 * the confirm dialog are stubbed to passthrough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const isDesktop = vi.fn(() => true);
const appVersion = vi.fn(async () => '1.2.3');
const checkForUpdate = vi.fn(async () => null as null | Record<string, unknown>);
const installUpdate = vi.fn(async () => {});

vi.mock('@papercusp/operator-core/lib/version-tauri', () => ({
  isDesktop: () => isDesktop(),
  appVersion: () => appVersion(),
  checkForUpdate: () => checkForUpdate(),
  installUpdate: () => installUpdate(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// Operator connectivity — drives the background-check gate. Default online.
let offlineState = false;
vi.mock('@papercusp/sync', () => ({
  useSyncConnectivity: () => ({ offline: offlineState }),
}));

// Tooltip just wraps its children; render them inline.
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Confirm dialog — `confirm` resolves to whatever we set; element is inert.
let confirmResult = true;
const confirmFn = vi.fn(async () => confirmResult);
vi.mock('../harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmFn, element: null }),
}));

import { toast } from 'sonner';
import UpdateChip from './UpdateChip';

beforeEach(() => {
  isDesktop.mockReturnValue(true);
  appVersion.mockResolvedValue('1.2.3');
  checkForUpdate.mockResolvedValue(null);
  installUpdate.mockClear();
  installUpdate.mockResolvedValue(undefined);
  checkForUpdate.mockClear();
  offlineState = false;
  confirmResult = true;
  confirmFn.mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
});
afterEach(cleanup);

describe('UpdateChip', () => {
  it('renders nothing in web (non-desktop) mode', () => {
    isDesktop.mockReturnValue(false);
    const { container } = render(<UpdateChip />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the plain version chip when there is no update available', async () => {
    render(<UpdateChip />);
    // version resolves async on mount → the "v1.2.3" check chip appears.
    const chip = await screen.findByRole('button', { name: /v1\.2\.3/ });
    expect(chip).toBeTruthy();
  });

  it('clicking the version chip force-checks for updates (poll non-silent)', async () => {
    render(<UpdateChip />);
    const chip = await screen.findByRole('button', { name: /v1\.2\.3/ });
    checkForUpdate.mockClear();
    fireEvent.click(chip);
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalled());
  });

  it('does NOT background-check while the operator is offline (silent mount poll skipped)', async () => {
    offlineState = true;
    render(<UpdateChip />);
    // The version still resolves (appVersion is not gated) so the chip renders…
    await screen.findByRole('button', { name: /v1\.2\.3/ });
    // …but the silent background check is skipped while disconnected — this is
    // what prevents the updater plugin's `error sending request` log churn.
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('a manual click still force-checks even while offline (user gets feedback)', async () => {
    offlineState = true;
    render(<UpdateChip />);
    const chip = await screen.findByRole('button', { name: /v1\.2\.3/ });
    checkForUpdate.mockClear();
    fireEvent.click(chip);
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalled());
  });

  it('renders the Update button when a newer release is available', async () => {
    checkForUpdate.mockResolvedValue({
      available: true,
      new_version: '2.0.0',
      current_version: '1.2.3',
      notes: 'new stuff',
    });
    render(<UpdateChip />);
    const btn = await screen.findByRole('button', { name: /Update to v2\.0\.0/ });
    expect(btn).toBeTruthy();
  });

  it('clicking Update confirms then installs', async () => {
    checkForUpdate.mockResolvedValue({
      available: true,
      new_version: '2.0.0',
      current_version: '1.2.3',
      notes: null,
    });
    render(<UpdateChip />);
    const btn = await screen.findByRole('button', { name: /Update to v2\.0\.0/ });
    fireEvent.click(btn);
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    await waitFor(() => expect(installUpdate).toHaveBeenCalled());
  });

  it('does NOT install when the user declines the confirm', async () => {
    confirmResult = false;
    checkForUpdate.mockResolvedValue({
      available: true,
      new_version: '2.0.0',
      current_version: '1.2.3',
      notes: null,
    });
    render(<UpdateChip />);
    const btn = await screen.findByRole('button', { name: /Update to v2\.0\.0/ });
    fireEvent.click(btn);
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(installUpdate).not.toHaveBeenCalled();
  });
});
