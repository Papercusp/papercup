import { createFileRoute, notFound } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { InsightsTab, type InsightsTabProps } from '@/app/harness/insights/InsightsTab';

/**
 * /harness/$slug/insights — Vite mirror of the SSR Next page at
 * apps/operator/app/harness/[slug]/insights/page.tsx.
 *
 * Phase 8 P-073g target route. The SSR page is unreachable through
 * the operator-vite SPA fallback, so this mirror exists so the
 * InsightsFirstVisitGate's `window.location.assign('/harness/:slug/insights')`
 * lands in the live UI.
 *
 * Fetches /api/harness/:slug/insights (the JSON endpoint that wraps
 * loadHarnessInsights) on mount + renders InsightsTab. POSTs
 * /api/harness/:slug/insights-first-visit afterwards to mark seen.
 *
 * The endpoint returns the same shape InsightsTab consumes (project /
 * activity / people / yourPlace / howItWorks / spend) so this route
 * is a thin fetch-then-render component.
 */

export const Route = createFileRoute('/harness/$slug/insights')({
  component: HarnessInsightsPage,
});

interface InsightsApiResponse {
  insights?: InsightsTabProps;
}

function HarnessInsightsPage() {
  const { slug } = Route.useParams();
  const [insights, setInsights] = useState<InsightsTabProps | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      throw notFound();
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/insights`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setError(`HTTP ${res.status}`);
          return;
        }
        const body = (await res.json().catch(() => ({}))) as InsightsApiResponse;
        if (cancelled) return;
        if (body.insights) setInsights(body.insights);
        else setError('insights payload missing');
        // Best-effort: mark first-visit seen so the gate stops force-routing.
        void fetch(`/api/harness/${encodeURIComponent(slug)}/insights-first-visit`, {
          method: 'POST',
        }).catch(() => {});
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (error) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-dim, #888)', fontSize: 13 }}>
        <p>Could not load insights for <code>{slug}</code>: {error}</p>
      </div>
    );
  }

  if (!insights) {
    return (
      <div style={{ padding: 32, color: 'var(--fg-dim, #888)', fontSize: 13 }}>
        Loading insights…
      </div>
    );
  }

  return <InsightsTab slug={slug} {...insights} />;
}
