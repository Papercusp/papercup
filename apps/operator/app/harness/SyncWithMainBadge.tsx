'use client';

/**
 * SyncWithMainBadge — Phase 9 P-055a.
 *
 * Polls GET /api/harness/:slug/sync-status every 60s and renders a
 * compact badge: "up to date" | "behind N" | "?" (unknown).
 * Click → opens SyncWithMainDialog.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, RefreshCw } from 'lucide-react';
import { COLORS, FONTS } from './theme';
import type { SyncStatusSnapshot } from '@/lib/harness/sync-with-main-types';

const POLL_INTERVAL_MS = 60_000;

interface Props {
  slug: string;
  githubUserId: number;
  onOpenDialog: () => void;
}

export function SyncWithMainBadge({ slug, githubUserId, onOpenDialog }: Props) {
  const [snap, setSnap] = useState<SyncStatusSnapshot | null>(null);
  const [polling, setPolling] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!slug || githubUserId <= 0) return;
    setPolling(true);
    try {
      const res = await fetch(
        `/api/harness/${encodeURIComponent(slug)}/sync-status?github_user_id=${githubUserId}`,
      );
      if (res.ok) {
        const data = (await res.json()) as SyncStatusSnapshot;
        setSnap(data);
      }
    } catch {
      // transient — keep previous snap
    } finally {
      setPolling(false);
    }
  }, [slug, githubUserId]);

  useEffect(() => {
    void fetchStatus();
    timerRef.current = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchStatus]);

  const label = (() => {
    if (!snap) return null;
    if (snap.status === 'up_to_date') return 'up to date';
    if (snap.status === 'behind') return `behind ${snap.behind_count}`;
    return '?';
  })();

  const color = (() => {
    if (!snap || snap.status === 'up_to_date') return COLORS.textMuted;
    if (snap.status === 'behind') return '#f59e0b'; // amber
    return COLORS.textMuted;
  })();

  if (!snap && !polling) return null;

  return (
    <button
      onClick={onOpenDialog}
      title="Sync status with main branch"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '2px 6px',
        borderRadius: 4,
        color,
        fontSize: FONTS.size.xs,
        fontFamily: FONTS.mono,
      }}
    >
      {polling ? (
        <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />
      ) : (
        <GitBranch size={12} />
      )}
      {label ?? '…'}
    </button>
  );
}
