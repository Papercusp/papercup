/**
 * PinnedFeaturePanel — single-feature detail view, pinnable in the dock.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.2
 *
 * Backed by /api/harness/<slug>/status (filtered client-side for the
 * one feature — the REST read carries rich fields like notes/metadata the
 * consolidated sync row doesn't). The legacy 10s poll is gone (audit
 * P-058): the featuresConsolidated.bySlug subscription (useHarnessFeatures)
 * watches this feature's core fields and re-pulls REST when they change.
 * Used as the target of "Pin as panel" actions on feature rows in
 * RealFeaturesPanel.
 *
 * Params:
 *   harnessSlug: string (required)
 *   featureId:   string (required)
 */

'use client';

import { useEffect, useState } from 'react';
import type { PanelComponentProps } from './panel-registry';
import { useHarnessFeatures } from '../../adv/harnesses/useHarnessData';
import { LazyDetails } from '../../_components/LazyDetails';

interface Feature {
  id: string;
  title: string;
  status: string;
  summary?: string;
  notes?: string;
  attempts?: number;
  claims?: string[];
  needs_human_review?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
  kind?: string;
  ts?: number;
}

interface StatusResponse {
  features: Feature[];
}

const STATUS_COLORS: Record<string, string> = {
  passed: 'var(--good)',
  todo: '#94a3b8',
  failing: 'var(--bad)',
  validating: 'var(--warn)',
  deprecated: '#71717a',
};

export function PinnedFeaturePanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const featureId = (params.featureId as string) || '';
  const [feature, setFeature] = useState<Feature | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Live core fields for this feature via the consolidated subscription.
  // Their changes are the refetch trigger for the rich REST read below.
  const { features: liveFeatures } = useHarnessFeatures(slug);
  const live = liveFeatures?.find((f) => f.id === featureId) ?? null;

  useEffect(() => {
    if (!slug || !featureId) return;
    setError(null);
    let cancel = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/status`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j: StatusResponse = await r.json();
        if (cancel) return;
        const f = j.features.find((x) => x.id === featureId);
        if (!f) {
          setError(new Error(`Feature ${featureId} not found in ${slug}`));
          return;
        }
        setFeature(f);
        api.setTitle(`📌 ${f.id}: ${f.title.slice(0, 30)}${f.title.length > 30 ? '…' : ''}`);
      } catch (e) {
        if (cancel) return;
        setError(e as Error);
      }
    };
    load();
    return () => {
      cancel = true;
    };
    // live core-field changes (status/attempts/review) re-pull the rich REST
    // detail — push-driven freshness instead of the old 10s timer.
  }, [slug, featureId, api, live?.status, live?.attempts, live?.needsReview]);

  if (!slug || !featureId) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        Missing required params: harnessSlug + featureId
      </div>
    );
  }
  if (error)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--bad)' }}>
        Failed: {error.message}
      </div>
    );
  if (!feature)
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        Loading {featureId}…
      </div>
    );

  return (
    <div
      style={{
        padding: 16,
        height: '100%',
        overflow: 'auto',
        fontSize: 12,
        color: 'var(--fg)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: STATUS_COLORS[feature.status] ?? '#666',
            flexShrink: 0,
          }}
          title={feature.status}
        />
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
            color: 'var(--fg-mute)',
          }}
        >
          {feature.id}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 5px',
            background: STATUS_COLORS[feature.status] ?? '#333',
            color: '#111',
            borderRadius: 2,
          }}
        >
          {feature.status}
        </span>
        {feature.kind && (
          <span style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
            {feature.kind}
          </span>
        )}
        {feature.needs_human_review && (
          <span
            style={{
              fontSize: 10,
              padding: '1px 5px',
              background: '#7c2d12',
              color: '#fed7aa',
              borderRadius: 2,
            }}
          >
            REVIEW
          </span>
        )}
      </div>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>
        {feature.title}
      </h3>
      {feature.summary && (
        <p style={{ margin: '0 0 16px', color: 'var(--fg-mute)', lineHeight: 1.5 }}>
          {feature.summary}
        </p>
      )}
      {feature.attempts !== undefined && (
        <Row label="attempts" value={String(feature.attempts)} />
      )}
      {feature.claims && feature.claims.length > 0 && (
        <Row label="claims" value={feature.claims.join(', ')} />
      )}
      {feature.tags && feature.tags.length > 0 && (
        <Row label="tags" value={feature.tags.join(', ')} />
      )}
      {feature.metadata && Object.keys(feature.metadata).length > 0 && (
        <LazyDetails
          style={{ marginTop: 8 }}
          summaryStyle={{ cursor: 'pointer', color: 'var(--fg-mute)', fontSize: 11 }}
          summary="metadata"
        >
          <pre
            style={{
              margin: '4px 0 0',
              padding: 8,
              background: 'var(--bg-2)',
              fontSize: 11,
              borderRadius: 3,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(feature.metadata, null, 2)}
          </pre>
        </LazyDetails>
      )}
      {feature.notes && (
        <LazyDetails
          style={{ marginTop: 8 }}
          summaryStyle={{ cursor: 'pointer', color: 'var(--fg-mute)', fontSize: 11 }}
          summary="notes"
        >
          <pre
            style={{
              margin: '4px 0 0',
              padding: 8,
              background: 'var(--bg-2)',
              fontSize: 11,
              borderRadius: 3,
              whiteSpace: 'pre-wrap',
            }}
          >
            {feature.notes}
          </pre>
        </LazyDetails>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '3px 0',
        fontSize: 11,
        color: 'var(--fg-mute)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <span style={{ minWidth: 80, color: 'var(--fg-mute)' }}>{label}</span>
      <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
        {value}
      </span>
    </div>
  );
}
