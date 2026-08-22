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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const desktopAllowed = vi.fn(async () => true);
const appVersion = vi.fn(async () => '1.2.3');
const checkForUpdate = vi.fn(async () => null as null | Record<string, unknown>);
const installUpdate = vi.fn(async () => {});
const revertTo = vi.fn(async (_tag: string) => {});

vi.mock('@papercusp/operator-core/lib/version-tauri', () => ({
  appVersion: () => appVersion(),
  checkForUpdate: () => checkForUpdate(),
  installUpdate: () => installUpdate(),
  revertTo: (tag: string) => revertTo(tag),
}));
vi.mock('@/lib/ipc-status-tauri', () => ({ canUseContentOriginDesktopActions: () => desktopAllowed() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// `@tauri-apps/api/event` — UpdateChip dynamically imports `listen` to drive the
// download-progress bar (WI-5011). Capture the registered callback + a spy
// unlisten fn so tests can fire synthetic `update-download-progress` events
// and assert the listener is torn down on unmount.
type ProgressListener = (event: { payload: { downloaded: number; total: number | null } }) => void;
let progressListener: ProgressListener | null = null;
const unlistenSpy = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, cb: ProgressListener) => {
    progressListener = cb;
    return unlistenSpy;
  }),
}));

// Operator connectivity — drives the background-check gate. Default online.
let offlineState = false;
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
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
  desktopAllowed.mockResolvedValue(true);
  desktopAllowed.mockClear();
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
  progressListener = null;
  unlistenSpy.mockClear();
});
afterEach(cleanup);

describe('UpdateChip', () => {
  it('renders nothing without content-origin desktop authority', async () => {
    desktopAllowed.mockResolvedValue(false);
    const { container } = render(<UpdateChip />);
    await act(async () => { await Promise.resolve(); });
    expect(container.firstChild).toBeNull();
    expect(appVersion).not.toHaveBeenCalled();
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

  // A FAILED check and an UP-TO-DATE check both arrive as `available: false` —
  // the Tauri updater protocol reports an unreachable release host as a plain
  // "no update". Telling the user "you're on the latest" there is a lie we
  // cannot detect in the field: the app sits on a stale version forever and
  // never says a word. `check_failed` is the only thing separating them.
  it('reports a FAILED check as failed — never as "you are on the latest"', async () => {
    checkForUpdate.mockResolvedValue({
      available: false,
      current_version: '1.2.3',
      new_version: null,
      notes: null,
      check_failed: true,
      check_reason: 'fetch_failed',
    });
    render(<UpdateChip />);
    const chip = await screen.findByRole('button', { name: /v1\.2\.3/ });
    fireEvent.click(chip);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [title, opts] = vi.mocked(toast.error).mock.calls.at(-1) as [string, { description?: string }];
    expect(title).toMatch(/couldn.t check/i);
    expect(opts?.description).toMatch(/fetch_failed/);
    // The load-bearing assertion: we must NOT have claimed the user is current.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a no_candidate check says the channel has no releases yet — never that the host is unreachable (WI-5010)', async () => {
    // The manifest route answers cannot_check/no_candidate when the host IS
    // reachable but this channel has nothing published (a beta user while all
    // releases are alpha). That must read as an informational "nothing here
    // yet", not a scary transport failure — and never as "you're current".
    checkForUpdate.mockResolvedValue({
      available: false,
      current_version: '1.2.3',
      new_version: null,
      notes: null,
      check_failed: true,
      check_reason: 'no_candidate',
    });
    render(<UpdateChip />);
    const chip = await screen.findByRole('button', { name: /v1\.2\.3/ });
    fireEvent.click(chip);

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(vi.mocked(toast.info).mock.calls.at(-1)?.[0]).toMatch(/no releases published/i);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('still reports a genuine up-to-date check as up to date', async () => {
    checkForUpdate.mockResolvedValue({
      available: false,
      current_version: '1.2.3',
      new_version: null,
      notes: null,
      check_failed: false,
      check_reason: null,
    });
    render(<UpdateChip />);
    const chip = await screen.findByRole('button', { name: /v1\.2\.3/ });
    fireEvent.click(chip);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls.at(-1)?.[0]).toMatch(/latest/i);
    expect(toast.error).not.toHaveBeenCalled();
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

  // The standalone footer "Update to vX" button also reflects progress inline
  // once a total is known (the popover card's fuller readout is covered
  // below, WI-5011).
  it('the footer install button appends a live percentage once a total is known', async () => {
    checkForUpdate.mockResolvedValue({
      available: true,
      new_version: '2.0.0',
      current_version: '1.2.3',
      notes: null,
    });
    render(<UpdateChip />);
    const btn = await screen.findByRole('button', { name: /Update to v2\.0\.0/ });
    fireEvent.click(btn);
    await waitFor(() => expect(installUpdate).toHaveBeenCalled());
    await waitFor(() => expect(progressListener).not.toBeNull());

    act(() => {
      progressListener!({ payload: { downloaded: 1_717_986_918, total: 3_650_722_201 } });
    });

    await screen.findByRole('button', { name: /Installing… 47%/ });
  });

  it('unlistens the progress listener on unmount', async () => {
    render(<UpdateChip />);
    await screen.findByRole('button', { name: /v1\.2\.3/ });
    await waitFor(() => expect(progressListener).not.toBeNull());
    cleanup();
    expect(unlistenSpy).toHaveBeenCalled();
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

  it('the update card renders no_candidate as "no releases for this channel yet", not host-unreachable (WI-5010)', async () => {
    checkForUpdate.mockResolvedValue({
      available: false,
      current_version: '1.2.3',
      new_version: null,
      notes: null,
      check_failed: true,
      check_reason: 'no_candidate',
    });
    await openPanel();
    await screen.findByText(/No releases are published for the beta channel yet/);
    expect(screen.queryByText(/reach the release host/)).toBeNull();
  });

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

  // WI-5011: install_update/revert_to previously passed an empty chunk
  // callback to download_and_install, so a multi-GB download rendered only a
  // bare "Installing…"/"Reverting…" spinner for minutes with zero feedback.
  // Rust now emits `update-download-progress`; the Update Center card renders
  // a real byte/percentage readout from it.
  it('shows live download progress in the install card from the update-download-progress event (WI-5011)', async () => {
    checkForUpdate.mockResolvedValue({
      available: true,
      new_version: '2.0.0',
      current_version: '1.2.3',
      notes: null,
    });
    await openPanel();
    const btn = await screen.findByRole('button', { name: /Install v2\.0\.0 and restart/ });
    fireEvent.click(btn);
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    await waitFor(() => expect(installUpdate).toHaveBeenCalled());
    // The progress listener attaches on mount, independent of the install
    // click — wait for it before firing the synthetic event.
    await waitFor(() => expect(progressListener).not.toBeNull());

    // Before any chunk lands, the card shows an indeterminate readout rather
    // than nothing.
    await screen.findByText('Starting download…');

    act(() => {
      progressListener!({ payload: { downloaded: 1_717_986_918, total: 3_650_722_201 } });
    });

    // ~47% of ~3.4GB — the exact wording is fmtProgress's; this asserts the
    // card is showing real numbers instead of a bare spinner.
    await screen.findByText(/1\.6 GB \/ 3\.4 GB \(47%\)/);
  });

  it('shows live download progress on the reverting row from the same event (WI-5011)', async () => {
    await openPanel();
    await screen.findByText('v2.0.0-alpha');
    fireEvent.click(screen.getAllByRole('button', { name: 'Revert' })[0]);
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    await waitFor(() => expect(revertTo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(progressListener).not.toBeNull());

    act(() => {
      progressListener!({ payload: { downloaded: 500_000_000, total: 1_000_000_000 } });
    });

    await screen.findByText(/476\.8 MB \/ 953\.7 MB \(50%\)/);
  });
});
