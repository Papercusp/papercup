'use client';

/**
 * InsightsTabClient — Phase 8 P-073 client wrapper.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 *
 * Thin client wrapper around the pure-UI InsightsTab. Fetches
 * `/api/harness/:slug/insights` on mount + on slug change, renders
 * loading / error / data states. Consumers (HarnessDashboard, a
 * sidebar router, etc.) drop this in without thinking about data
 * shape.
 *
 * Refresh: optional `refreshIntervalMs` for poll behaviour. Default
 * disabled — the substrate boot will eventually push deltas through
 * @restart/sse; until then, callers can opt into polling.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { InsightsTab, type InsightsTabProps } from './InsightsTab';

const LOADING: CSSProperties = {
  padding: 24,
  fontSize: 13,
  color: 'var(--fg-dim, #888)',
};

const ERROR_BOX: CSSProperties = {
  padding: 24,
  fontSize: 13,
  color: 'var(--fg-warning, #FF9800)',
  border: '1px solid var(--fg-warning, #FF9800)',
  borderRadius: 8,
  margin: 24,
};

export interface InsightsTabClientProps {
  slug: string;
  /** Re-fetch every N ms. Default 0 (disabled). */
  refreshIntervalMs?: number;
  /** Override the activity_limit query param. */
  activityLimit?: number;
  /** For tests / non-Next environments. */
  fetchImpl?: typeof fetch;
}

interface FetchState {
  status: 'loading' | 'ready' | 'error';
  data?: InsightsTabProps;
  error?: string;
}

async function fetchInsights(
  slug: string,
  activityLimit: number | undefined,
  fetchImpl: typeof fetch,
): Promise<InsightsTabProps> {
  const url = activityLimit
    ? `/api/harness/${encodeURIComponent(slug)}/insights?activity_limit=${activityLimit}`
    : `/api/harness/${encodeURIComponent(slug)}/insights`;
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as { insights?: InsightsTabProps };
  if (!json.insights) {
    throw new Error('Response missing `insights` envelope');
  }
  return json.insights;
}

export function InsightsTabClient(props: InsightsTabClientProps): ReactNode {
  const {
    slug,
    refreshIntervalMs = 0,
    activityLimit,
    fetchImpl = fetch,
  } = props;

  const [state, setState] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    const run = async () => {
      try {
        const data = await fetchInsights(slug, activityLimit, fetchImpl);
        if (!cancelled) setState({ status: 'ready', data });
      } catch (e) {
        if (!cancelled) {
          setState({
            status: 'error',
            error: (e as Error)?.message ?? 'fetch failed',
          });
        }
      }
    };
    void run();
    let timer: ReturnType<typeof setInterval> | null = null;
    if (refreshIntervalMs > 0) {
      timer = setInterval(() => {
        void run();
      }, refreshIntervalMs);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [slug, activityLimit, refreshIntervalMs, fetchImpl]);

  if (state.status === 'loading' && !state.data) {
    return (
      <div style={LOADING} data-testid="insights-tab-client-loading">
        Loading insights…
      </div>
    );
  }
  if (state.status === 'error' && !state.data) {
    return (
      <div
        role="alert"
        style={ERROR_BOX}
        data-testid="insights-tab-client-error"
      >
        Failed to load insights: {state.error}
      </div>
    );
  }
  if (!state.data) return null;
  return <InsightsTab {...state.data} />;
}
