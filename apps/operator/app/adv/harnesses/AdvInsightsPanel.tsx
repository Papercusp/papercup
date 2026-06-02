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
import { HarnessClaimHeader } from '../../_components/HarnessClaimHeader';
import { useHarnessClaimStatus } from './useHarnessClaimStatus';

const MSG: React.CSSProperties = { padding: 16, fontSize: 13, color: 'var(--fg-mute)' };

export default function AdvInsightsPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [data, setData] = useState<InsightsTabProps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // P-069 (a/b/e) — real claim status for the harness, server-resolved
  // against the local viewer. Feeds the mounted HarnessClaimHeader (banner +
  // CTA) and overrides the InsightsTab ProjectCard's badge, which until now
  // always rendered the hardcoded 'unclaimed' fallback from loadHarnessInsights.
  const { data: claim, claim: doClaim, claiming } = useHarnessClaimStatus(slug);

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

  // Overlay the real claim status onto the ProjectCard badge (P-069a) when
  // the claim-status read has landed; otherwise the insights fallback stands.
  const withClaim: InsightsTabProps = claim
    ? {
        ...data,
        project: {
          ...data.project,
          claimStatus: claim.status,
          claimantLogin: claim.claimant_login,
        },
      }
    : data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {claim && (
        <div style={{ padding: '12px 16px 0' }}>
          <HarnessClaimHeader
            title={data.project.name}
            href={data.project.githubUrl}
            status={claim.status}
            claimantLogin={claim.claimant_login}
            supersededByHref={claim.superseded_by_href}
            viewerCanClaim={claim.viewer_can_claim && !claiming}
            onClaimClick={() => void doClaim()}
          />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <InsightsTab {...withClaim} />
      </div>
    </div>
  );
}
