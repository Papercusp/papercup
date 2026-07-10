'use client';

/**
 * InsightsFirstVisitGate — Phase 8 P-074 client redirect.
 *
 * Plan: papercusp-dogfood-v5-2026-05-23 P-074 + D-029.
 *
 * On mount, calls GET /api/harness/:slug/insights-first-visit. If the
 * server says force_route=true (no row OR null seen_at_ts for the
 * viewer), the component navigates to /harness/:slug/insights via
 * the provided `redirect` callback (default: window.location.assign).
 *
 * Renders nothing — it's a side-effect-only component meant to live
 * at the top of any harness page that should respect the gate.
 *
 * Pure-UI testability: redirect + fetchImpl are injectable.
 */

import { useEffect, type ReactNode } from 'react';

export interface InsightsFirstVisitGateProps {
  slug: string;
  /** Override navigation. Default: window.location.assign. */
  redirect?: (href: string) => void;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Suppress the redirect entirely. Useful if the user is already
   * on /insights — the gate should run mark on exit but not re-route. */
  disabled?: boolean;
}

interface FirstVisitResponse {
  force_route?: boolean;
  seen_at_ts?: number | null;
}

export function InsightsFirstVisitGate(
  props: InsightsFirstVisitGateProps,
): ReactNode {
  const { slug, redirect, fetchImpl, disabled = false } = props;

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    const f = fetchImpl ?? fetch;
    const r = redirect ?? ((href: string) => {
      if (typeof window !== 'undefined') {
        window.location.assign(href);
      }
    });
    (async () => {
      try {
        const res = await f(
          `/api/harness/${encodeURIComponent(slug)}/insights-first-visit`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as FirstVisitResponse;
        if (cancelled) return;
        if (json.force_route) {
          r(`/harness/${encodeURIComponent(slug)}/insights`);
        }
      } catch {
        // never block on transient network issues
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, redirect, fetchImpl, disabled]);

  return null;
}

/**
 * Companion side-effect: mark the gate as seen. Call this from the
 * /insights page on mount (after a small delay so the user actually
 * sees Insights for a moment before the dismissal is recorded).
 *
 * Standalone so consumers can place it inside InsightsTab's onMount
 * or inside a "dismiss" button handler.
 */
export async function markInsightsSeenOverHttp(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(
      `/api/harness/${encodeURIComponent(slug)}/insights-first-visit`,
      { method: 'POST', cache: 'no-store' },
    );
  } catch {
    // best-effort
  }
}
