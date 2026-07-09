'use client';


import { Tooltip } from '@/app/harness/Tooltip';
// Footer chip showing the desktop app version + an inline "Update" button
// when a new release is available. Renders null in web mode.
//
// On mount: reads the current version from Tauri, then polls the
// configured updater endpoint (GitHub Releases /latest/download/latest.json
// per tauri.conf.json) for a newer release. Polls again every 6 hours so
// users running long-lived sessions still see new releases. The user can
// also force-check by clicking the chip.
//
// One-click install: invokes `install_update`, which:
//   1. kills the sidecar + embedded-postgres-server (no orphans)
//   2. downloads the platform tarball, verifies the minisign signature
//      against the pubkey embedded in tauri.conf.json
//   3. atomically swaps the binary
//   4. calls app.restart() — the Tauri shell relaunches with the new
//      version, the workspace and registry are untouched.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSyncConnectivity } from '@papercusp/sync';
import {
  UpdateInfo,
  appVersion,
  checkForUpdate,
  installUpdate,
  isDesktop,
} from '@papercusp/operator-core/lib/version-tauri';
import { useConfirmDialog } from '../harness/useConfirmDialog';

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

export default function UpdateChip() {
  const [desktop, setDesktop] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  // The operator's live-transport state (SSE/REST). Used to skip BACKGROUND
  // update checks while the operator is unreachable — see `poll`.
  const { offline } = useSyncConnectivity();

  useEffect(() => {
    setDesktop(isDesktop());
  }, []);

  const refreshVersion = useCallback(() => {
    appVersion().then(setVersion).catch(() => {});
  }, []);

  const poll = useCallback(async (silent: boolean) => {
    if (!isDesktop()) return;
    // Skip BACKGROUND (silent) checks while the operator is unreachable. The
    // check would just race a down / not-yet-ready operator and make the
    // tauri_plugin_updater crate log a scary `failed to check for updates:
    // error sending request` — which recovers on the next attempt anyway and
    // correlates 1:1 with operator restart churn (the chip remounts on the
    // SPA's reconnect re-render, each remount firing this poll). A user-
    // initiated check (silent=false) still attempts, so a manual click always
    // gives feedback. When the transport recovers, this effect re-runs (poll's
    // `offline` dep) and a catch-up check fires against a confirmed-reachable
    // operator.
    if (silent && offline) return;
    setChecking(true);
    try {
      const u = await checkForUpdate();
      setInfo(u);
      if (!silent && u) {
        toast.success(
          u.available
            ? `Update available: v${u.new_version}`
            : `You're on v${u.current_version} (latest)`,
        );
      }
    } catch (e: any) {
      if (!silent) toast.error(`update check failed: ${e?.message ?? e}`);
    } finally {
      setChecking(false);
    }
  }, [offline]);

  useEffect(() => {
    if (!desktop) return;
    refreshVersion();
    poll(true);
    const id = window.setInterval(() => poll(true), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [desktop, refreshVersion, poll]);

  const onInstall = async () => {
    if (installing) return;
    if (!await askConfirm({
      title: `Install v${info?.new_version ?? '?'} and restart?`,
      body: 'Papercusp will quit, swap binaries, and relaunch. In-flight work is interrupted.',
      confirmLabel: 'Install and restart',
    })) return;
    setInstalling(true);
    try {
      await installUpdate();
      // The promise typically never resolves — Tauri restarts the process.
    } catch (e: any) {
      // Linux currently has no AppImage swap target (CI build of AppImage is
      // blocked by linuxdeploy/FUSE friction), so install_update fails on
      // Linux with `no_compatible_assets`. Fall back to opening the GitHub
      // releases page so the user can download a fresh .deb / .rpm manually.
      const msg = String(e?.message ?? e);
      if (msg.includes('no_compatible_assets') || msg.includes('compatible')) {
        toast.info('Auto-install isn’t available on this platform yet — opening releases page.');
        window.open(
          'https://github.com/Papercusp/papercusp-desktop/releases/latest',
          '_blank',
          'noopener,noreferrer',
        );
      } else {
        toast.error(`install failed: ${msg}`);
      }
      setInstalling(false);
    }
  };

  if (!desktop) return null;
  if (!version) return null;

  const updateAvailable = info?.available && info.new_version;

  if (updateAvailable) {
    return (
      <>
      {confirmEl}
      <Tooltip label={info?.notes ?? `New version v${info!.new_version} available`}><button
        type="button"
        onClick={onInstall}
        disabled={installing}

        style={{
          background: 'var(--accent)',
          border: '1px solid var(--accent, #2d7a40)',
          color: 'var(--accent-ink)',
          padding: '3px 10px',
          borderRadius: 4,
          cursor: installing ? 'wait' : 'pointer',
          font: 'inherit',
          fontSize: 13,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
        {installing ? 'Installing…' : `Update to v${info!.new_version}`}
      </button></Tooltip>
      </>
    );
  }

  return (
    <Tooltip label={checking ? 'Checking for updates…' : 'Click to check for updates'}><button
      type="button"
      onClick={() => poll(false)}
      disabled={checking}

      style={{
        background: 'transparent',
        border: '1px solid var(--border, #2a2a2a)',
        color: 'var(--fg-mute, #777)',
        padding: '3px 8px',
        borderRadius: 4,
        cursor: checking ? 'wait' : 'pointer',
        font: 'inherit',
        fontSize: 12,
      }}
    >
      v{version}
      {checking && <span style={{ marginLeft: 6, opacity: 0.6 }}>…</span>}
    </button></Tooltip>
  );
}
