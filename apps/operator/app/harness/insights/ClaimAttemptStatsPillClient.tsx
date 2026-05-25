'use client';

/**
 * ClaimAttemptStatsPillClient — fetch + render wrapper.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 *
 * Polls /api/harness/:slug/claim-attempts?stats=1 and renders
 * ClaimAttemptStatsPill. Drop-in for any client surface that wants
 * to show the won/lost/error breakdown for one harness.
 *
 * Pure UI; fetchImpl + refresh interval injectable for tests.
 * Renders nothing during first load + sustained failure + empty
 * total so embedding slots stay quiet.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { ClaimAttemptStatsPill } from './ClaimAttemptStatsPill';

export interface ClaimAttemptStatsPillClientProps {
  slug: string;
  /** Default 15s — claim audit doesn't move fast. */
  refreshIntervalMs?: number;
  /** Forwarded to ClaimAttemptStatsPill. */
  compact?: boolean;
  fetchImpl?: typeof fetch;
}

interface StatsResponse {
  stats?: {
    total?: number;
    won?: number;
    lost?: number;
    error?: number;
  };
}

interface StatsState {
  total: number;
  won: number;
  lost: number;
  error: number;
}

export function ClaimAttemptStatsPillClient(
  props: ClaimAttemptStatsPillClientProps,
): ReactNode {
  const { slug, refreshIntervalMs = 15_000, compact, fetchImpl } = props;
  const [stats, setStats] = useState<StatsState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    const url = `/api/harness/${encodeURIComponent(slug)}/claim-attempts?stats=1`;
    const run = async () => {
      try {
        const r = await f(url, { cache: 'no-store' });
        if (!r.ok) return;
        const json = (await r.json()) as StatsResponse;
        if (cancelled || !json.stats) return;
        setStats({
          total: Number(json.stats.total ?? 0),
          won: Number(json.stats.won ?? 0),
          lost: Number(json.stats.lost ?? 0),
          error: Number(json.stats.error ?? 0),
        });
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
  }, [slug, refreshIntervalMs, fetchImpl]);

  if (!stats) return null;
  return (
    <ClaimAttemptStatsPill
      total={stats.total}
      won={stats.won}
      lost={stats.lost}
      error={stats.error}
      compact={compact}
    />
  );
}
