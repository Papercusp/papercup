'use client';

// adv:insights — Phase-8 Insights as a dock panel. The InsightsTab component
// (app/harness/insights/InsightsTab) is pure-render — it takes pre-computed
// InsightsTabProps. This wrapper supplies them by fetching the canonical
// endpoint GET /api/harness/:slug/insights (which returns
// `{ insights: InsightsTabProps }`), so the built+tested Phase-8 Insights view
// is reachable in the live /adv harness dock (it previously had no consumer /
// mount point). One-shot read + Refresh, per the /adv no-polling ethos.

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { InsightsTab, type InsightsTabProps } from '../../harness/insights/InsightsTab';

const MSG: React.CSSProperties = { padding: 16, fontSize: 13, color: 'var(--fg-mute)' };

export default function AdvInsightsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [data, setData] = useState<InsightsTabProps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/insights`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { insights: InsightsTabProps }) => {
        if (!cancelled) setData(j.insights);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, tick]);

  if (!slug) return <div style={MSG}>No harness selected.</div>;
  if (error) {
    return (
      <div style={{ ...MSG, color: 'var(--bad, #f87171)' }}>
        Failed to load insights: {error}{' '}
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          style={{ marginLeft: 8, cursor: 'pointer' }}
        >
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    );
  }
  if (!data) return <div style={MSG}>Loading insights…</div>;
  return <InsightsTab {...data} />;
}
