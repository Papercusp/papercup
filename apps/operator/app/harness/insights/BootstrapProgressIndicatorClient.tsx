'use client';

/**
 * BootstrapProgressIndicatorClient — Phase 5b P-066 wired-up wrapper.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 (Q-6 resolution).
 *
 * Polls /api/harness/:slug/bootstrap-progress and renders the
 * BootstrapProgressIndicator with live N/M counts:
 *
 *   - null snapshot         → renders nothing (substrate not booted
 *                              OR no merge activity recorded yet)
 *   - caughtUp=true         → "Up to date" pill (auto-dismisses)
 *   - caughtUp=false        → "Syncing N/M" pill
 *
 * `highestSeen` becomes the M (total target). If the indicator's
 * default render is `Syncing mergedOps/highestSeen` then a brand-new
 * harness whose `highestSeen === mergedOps` immediately appears
 * caught-up; for those, the pill stays hidden because totalOps==0
 * when the snapshot is null OR the merge counts are equal AND
 * caughtUp is true.
 *
 * Pure UI; fetchImpl + refreshIntervalMs are injectable for tests.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { BootstrapProgressIndicator } from './BootstrapProgressIndicator';

export interface BootstrapProgressSnapshot {
  workspaceId: string;
  harnessSlug: string;
  mergedOps: number;
  highestSeen: number;
  lastChangeMs: number;
  caughtUp: boolean;
}

export interface BootstrapProgressIndicatorClientProps {
  slug: string;
  /** Poll interval in ms. Default 2000 (sleeping-laptop bootstrap is fast). */
  refreshIntervalMs?: number;
  /** Forward into the endpoint as ?idle_ms=N. Default omitted. */
  idleMs?: number;
  fetchImpl?: typeof fetch;
}

interface FetchResponse {
  progress?: BootstrapProgressSnapshot | null;
}

export function BootstrapProgressIndicatorClient(
  props: BootstrapProgressIndicatorClientProps,
): ReactNode {
  const { slug, refreshIntervalMs = 2000, idleMs, fetchImpl } = props;
  const [snap, setSnap] = useState<BootstrapProgressSnapshot | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    const qs = idleMs ? `?idle_ms=${idleMs}` : '';
    const url = `/api/harness/${encodeURIComponent(slug)}/bootstrap-progress${qs}`;
    const run = async () => {
      try {
        const res = await f(url, { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as FetchResponse;
        if (cancelled) return;
        setSnap(json.progress ?? null);
      } catch {
        // stay on last-known state
      }
    };
    void run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (refreshIntervalMs > 0) {
      timer = setInterval(() => void run(), refreshIntervalMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [slug, refreshIntervalMs, idleMs, fetchImpl]);

  if (dismissed) return null;
  if (!snap) return null;

  // Use highestSeen as the total target so caught-up converges visually
  // when the laptop catches up to the previously-known peak.
  const total = Math.max(snap.highestSeen, snap.mergedOps);
  // Brand-new harness with no merges yet: nothing to display.
  if (total === 0) return null;

  return (
    <BootstrapProgressIndicator
      totalOps={total}
      mergedOps={snap.mergedOps}
      onDismiss={() => setDismissed(true)}
    />
  );
}
