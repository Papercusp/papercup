'use client';

/**
 * SyncWithMainBadge — Phase 9 P-055a.
 *
 * Shows `up to date` / `behind N` / `?` by polling
 * GET /api/harness/:slug/sync-status?github_user_id=<N> every 60s.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { COLORS, FONTS } from './theme';
import type { SyncStatusSnapshot } from '../../lib/harness/sync-with-main-types';

const POLL_MS = 60_000;

interface Props {
  harnessSlug: string;
  githubUserId: number;
  /** Called when the badge is clicked — parent opens the SyncWithMainDialog. */
  onClick?: () => void;
}

async function fetchSyncStatus(
  harnessSlug: string,
  githubUserId: number,
): Promise<SyncStatusSnapshot> {
  const r = await fetch(
    `/api/harness/${encodeURIComponent(harnessSlug)}/sync-status?github_user_id=${githubUserId}`,
    { cache: 'no-store' },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<SyncStatusSnapshot>;
}

function SyncWithMainBadgeInner({ harnessSlug, githubUserId, onClick }: Props) {
  const [snap, setSnap] = useState<SyncStatusSnapshot | null>(null);
  const cancelRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const data = await fetchSyncStatus(harnessSlug, githubUserId);
      if (!cancelRef.current) setSnap(data);
    } catch {
      // network blip — keep prior value
    }
  }, [harnessSlug, githubUserId]);

  useEffect(() => {
    cancelRef.current = false;
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelRef.current = true;
      clearInterval(id);
    };
  }, [poll]);

  const label =
    snap === null
      ? '…'
      : snap.status === 'up_to_date'
        ? 'up to date'
        : snap.status === 'behind'
          ? `behind ${snap.behind_count}`
          : '?';

  const color =
    snap === null
      ? COLORS.textDim
      : snap.status === 'up_to_date'
        ? COLORS.successText
        : snap.status === 'behind'
          ? COLORS.dangerText
          : COLORS.textMuted;

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        snap?.status === 'unknown' && snap.poll_error
          ? `Sync check failed: ${snap.poll_error}`
          : 'Sync status with main branch — click to sync'
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'none',
        border: 'none',
        cursor: onClick ? 'pointer' : 'default',
        padding: '2px 6px',
        borderRadius: 4,
        fontFamily: FONTS.ui,
        fontSize: 11,
        color,
      }}
    >
      <RefreshCw size={10} />
      <span>{label}</span>
    </button>
  );
}

export const SyncWithMainBadge = memo(SyncWithMainBadgeInner);
export default SyncWithMainBadge;
