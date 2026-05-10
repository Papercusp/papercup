'use client';

import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSyncQuery } from '@restart/sync';

import { useWorkspaceId } from '@/lib/use-workspace-id';
import { remarkFeatureLinks } from './remarkFeatureLinks';
import { FeatureLink, type FeatureLite } from './FeatureLink';

interface Props {
  slug: string;
  onOpenFeature?: (id: string) => void;
}

interface ZeroFeatureRow {
  featureId: string;
  title: string;
  summary?: string | null;
  status: string;
  attempts: number | string;
  claims?: string | null;
  notes?: string | null;
}

const STATUS_VALUES: ReadonlySet<FeatureLite['status']> = new Set([
  'todo', 'in_progress', 'validating', 'failing', 'passed', 'blocked',
]);

function SummaryPanelInner({ slug, onOpenFeature }: Props) {
  const workspaceId = useWorkspaceId();

  // Summary text comes via Zero (push, no polling). The watcher mirrors
  // .harness/summary.md → harness_shared.harness_summaries on every edit.
  const { data: summaryRows } = useSyncQuery<{ harnessSlug: string; content: string }>({
    queryName: 'summary.byHarness',
    args: { harnessSlug: slug, workspaceId },
  });
  const source: string | null = useMemo(() => {
    if (!Array.isArray(summaryRows)) return null;
    return summaryRows[0]?.content ?? '';
  }, [summaryRows]);

  // Features come from the slug-agnostic Zero query (push, no polling).
  // Reads harness_shared.harness_features_consolidated by slug — works
  // for any registered harness without compile-time slug coupling.
  const { data: zeroFeatureRows } = useSyncQuery<ZeroFeatureRow>({
    queryName: 'featuresConsolidated.bySlug',
    args: slug ? { harnessSlug: slug } : undefined,
    enabled: !!slug,
  });

  const featuresById = useMemo(() => {
    const m = new Map<string, FeatureLite>();
    if (!Array.isArray(zeroFeatureRows)) return m;
    for (const zf of zeroFeatureRows) {
      const status = (STATUS_VALUES.has(zf.status as FeatureLite['status'])
        ? zf.status
        : 'todo') as FeatureLite['status'];
      let claims: string[] | undefined;
      if (zf.claims) {
        try {
          const parsed = JSON.parse(zf.claims);
          if (Array.isArray(parsed)) claims = parsed;
        } catch {}
      }
      m.set(zf.featureId, {
        id: zf.featureId,
        title: zf.title,
        status,
        attempts: typeof zf.attempts === 'number' ? zf.attempts : Number(zf.attempts) || 0,
        claims,
        notes: zf.notes ?? undefined,
      });
    }
    return m;
  }, [zeroFeatureRows]);

  const components = useMemo(() => ({
    a: (props: any) => {
      const fid = props['data-fid'];
      if (fid) {
        return (
          <FeatureLink fid={fid} feature={featuresById.get(fid) ?? null} onOpen={onOpenFeature}>
            {props.children}
          </FeatureLink>
        );
      }
      return <a {...props} target="_blank" rel="noreferrer" />;
    },
  }), [featuresById, onOpenFeature]);

  const outerStyle = {
    flex: 1,
    width: '100%',
    height: '100%',
    overflowY: 'auto' as const,
    padding: 20,
    background: 'var(--bg-2)',
    border: '1px solid color-mix(in oklab, var(--border), white 8%)',
    borderRadius: 14,
    boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
  };

  if (source === null) {
    return (
      <div style={outerStyle}>
        <div className="h-empty"><span className="h-empty-icon">…</span><span>loading…</span></div>
      </div>
    );
  }

  if (!source.trim()) {
    return (
      <div style={outerStyle}>
        <div className="h-empty">
          <span className="h-empty-icon">—</span>
          <span>no summary entries yet — the orchestrator writes one when something user-visible ships or a foundational decision is made</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-md" style={outerStyle}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkFeatureLinks]} components={components as any}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

const SummaryPanel = memo(SummaryPanelInner);
export default SummaryPanel;
