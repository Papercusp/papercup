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
const revertTo = vi.fn(async (_tag: string) => {});

vi.mock('@papercusp/operator-core/lib/version-tauri', () => ({
  isDesktop: () => isDesktop(),
  appVersion: () => appVersion(),
  checkForUpdate: () => checkForUpdate(),
  installUpdate: () => installUpdate(),
  revertTo: (tag: string) => revertTo(tag),
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
  revertTo.mockClear();
  revertTo.mockResolvedValue(undefined);
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

/* ── Update Center panel (P-3) ─────────────────────────────────────────
 * Opening the version chip reveals the Update Center popover: a channel
 * switcher (PATCH /api/desktop/setup-wizard-state) and the release history
 * (GET /api/updates/history) with a guarded rollback. `fetch` is stubbed to
 * serve both endpoints; the history fixture has a current release plus older
 * installable ones so we can assert the "Current" marker and Revert buttons. */
const HISTORY = [
  {
    tag: 'desktop-v2.0.0-alpha', version: '2.0.0-alpha', channel: 'alpha', notes: 'alpha notes',
    pub_date: '2026-07-10T00:00:00Z', prerelease: true, is_current: false, installable: true,
  },
  {
    tag: 'desktop-v1.2.3', version: '1.2.3', channel: 'stable', notes: '',
    pub_date: '2026-07-05T00:00:00Z', prerelease: false, is_current: true, installable: true,
  },
  {
    tag: 'desktop-v1.0.0', version: '1.0.0', channel: 'stable', notes: '',
    pub_date: '2026-07-01T00:00:00Z', prerelease: false, is_current: false, installable: true,
  },
];

function jsonResponse(obj: unknown) {
  return { ok: true, json: async () => obj } as unknown as Response;
}

describe('UpdateChip — Update Center panel', () => {
  let savedChannel = 'beta';
  let lastPatched: string | null = null;
  let historyQueries: string[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (url.includes('/api/desktop/setup-wizard-state')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body ?? '{}');
        lastPatched = body.update_channel;
        savedChannel = body.update_channel;
        return jsonResponse({ update_channel: body.update_channel });
      }
      return jsonResponse({ update_channel: savedChannel });
    }
    if (url.includes('/api/updates/history')) {
      historyQueries.push(url);
      return jsonResponse({ channel: savedChannel, releases: HISTORY });
    }
    return jsonResponse({});
  });

  beforeEach(() => {
    savedChannel = 'beta';
    lastPatched = null;
    historyQueries = [];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openPanel() {
    render(<UpdateChip />);
    const chip = await screen.findByRole('button', { name: /v1\.2\.3/ });
    fireEvent.click(chip);
    // The popover content renders in a portal once open — wait for it.
    await screen.findByText('Update Center');
  }

  it('opening the chip shows the channel switcher on the saved channel', async () => {
    await openPanel();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    const beta = screen.getByRole('radio', { name: /Beta/ });
    expect(beta.getAttribute('aria-checked')).toBe('true');
  });

  it('opening the chip lists the channel release history with a current marker', async () => {
    await openPanel();
    await waitFor(() => expect(screen.getByText('v2.0.0-alpha')).toBeTruthy());
    expect(screen.getByText('v1.0.0')).toBeTruthy();
    // The running release is marked, not offered as a revert target.
    expect(screen.getByText(/Current/)).toBeTruthy();
    // Two older installable releases → two Revert buttons.
    expect(screen.getAllByRole('button', { name: 'Revert' })).toHaveLength(2);
  });

  it('picking a different channel PATCHes update_channel and reloads history', async () => {
    await openPanel();
    await screen.findByText('v2.0.0-alpha');
    historyQueries = [];
    fireEvent.click(screen.getByRole('radio', { name: /Stable/ }));
    await waitFor(() => expect(lastPatched).toBe('stable'));
    // History is re-read for the new channel.
    await waitFor(() => expect(historyQueries.length).toBeGreaterThan(0));
    const patchCall = fetchMock.mock.calls.find(
      ([u, i]) => String(u).includes('/setup-wizard-state') && (i as any)?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
  });

  it('Revert confirms then calls revert_to with the row\'s full git tag — never installs (P-4)', async () => {
    await openPanel();
    await screen.findByText('v2.0.0-alpha');
    // First Revert button targets the first non-current installable release.
    fireEvent.click(screen.getAllByRole('button', { name: 'Revert' })[0]);
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    await waitFor(() => expect(revertTo).toHaveBeenCalledTimes(1));
    // The full git tag is what the rollback endpoint resolves, not the display version.
    expect(revertTo).toHaveBeenCalledWith('desktop-v2.0.0-alpha');
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('declining the Revert confirm never calls revert_to', async () => {
    confirmResult = false;
    await openPanel();
    await screen.findByText('v2.0.0-alpha');
    fireEvent.click(screen.getAllByRole('button', { name: 'Revert' })[0]);
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(revertTo).not.toHaveBeenCalled();
  });

  it('a failed revert surfaces an error toast and re-enables the button', async () => {
    revertTo.mockRejectedValueOnce(new Error('fetch_failed'));
    await openPanel();
    await screen.findByText('v2.0.0-alpha');
    fireEvent.click(screen.getAllByRole('button', { name: 'Revert' })[0]);
    await waitFor(() => expect(revertTo).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringMatching(/failed: fetch_failed/)),
    );
  });
});
