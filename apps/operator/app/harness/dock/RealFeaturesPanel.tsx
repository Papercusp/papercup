/**
 * RealFeaturesPanel — feature list backed by /api/harness/<slug>/status.
 *
 * First real panel implementation. Demonstrates:
 *   - Per-instance data fetch keyed by params.harnessSlug
 *   - Loading + error + empty states
 *   - Status filter via local panel-state (transient, NOT in layout)
 *   - Multiple instances with different slugs = side-by-side compare
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §10 Phase 5
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PanelComponentProps } from './panel-registry';
import { openPanel, focusPanel } from './dock-actions';

interface Feature {
  id: string;
  title: string;
  status: string;
  summary?: string;
  needs_human_review?: boolean;
}

interface StatusResponse {
  features: Feature[];
  counts: Record<string, number>;
}

type FilterKey = 'all' | 'todo' | 'failing' | 'validating' | 'passed' | 'deprecated';

const STATUS_COLORS: Record<string, string> = {
  passed: '#4ade80',
  todo: 'var(--fg-mute)',
  failing: 'var(--bad)',
  validating: 'var(--warn)',
  deprecated: '#71717a',
};

export function RealFeaturesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');

  useEffect(() => {
    if (!slug) return;
    setError(null);
    let cancel = false;
    fetch(`/api/harness/${encodeURIComponent(slug)}/status`)
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((j: StatusResponse) => {
        if (cancel) return;
        setData(j);
        // Update panel title with slug + count so multiple instances are
        // distinguishable in the tab strip.
        api.setTitle(`Features: ${slug} (${j.features.length})`);
      })
      .catch((e: Error) => {
        if (cancel) return;
        setError(e);
      });
    return () => {
      cancel = true;
    };
  }, [slug, api]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.features;
    return data.features.filter((f) => f.status === filter);
  }, [data, filter]);

  if (!slug) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--muted-foreground,#888)' }}>
        No harness slug in params. Open this panel via the dock toolbar with a slug.
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--bad)' }}>
        Failed: {error.message}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--muted-foreground,#888)' }}>
        Loading {slug}…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '6px 8px',
          borderBottom: '1px solid var(--border, #333)',
          background: 'var(--card, #1a1a1a)',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        {(['all', 'todo', 'failing', 'validating', 'passed', 'deprecated'] as FilterKey[]).map(
          (key) => {
            const count =
              key === 'all'
                ? data.features.length
                : (data.counts[key] ?? 0);
            const active = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                style={{
                  padding: '2px 8px',
                  fontSize: 11,
                  background: active ? 'var(--accent,#2a2a2a)' : 'transparent',
                  color: active ? 'var(--foreground,#ccc)' : 'var(--muted-foreground,#888)',
                  border: '1px solid var(--border,#333)',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                {key} ({count})
              </button>
            );
          },
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontSize: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted-foreground,#888)' }}>
            No features match.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {filtered.map((f) => (
              <li
                key={f.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const id = openPanel({
                    type: 'pin:feature',
                    params: { harnessSlug: slug, featureId: f.id },
                    title: f.id,
                  });
                  focusPanel(id);
                }}
                onClick={(e) => {
                  // Cmd/Ctrl-click pins; plain click is reserved for
                  // future row-expand or no-op.
                  if (e.metaKey || e.ctrlKey) {
                    const id = openPanel({
                      type: 'pin:feature',
                      params: { harnessSlug: slug, featureId: f.id },
                      title: f.id,
                    });
                    focusPanel(id);
                  }
                }}
                title="Cmd/Ctrl-click or right-click to pin as panel"
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '6px 12px',
                  borderBottom: '1px solid var(--border-subtle,#222)',
                  alignItems: 'baseline',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: STATUS_COLORS[f.status] ?? '#666',
                    flexShrink: 0,
                  }}
                  title={f.status}
                />
                <span
                  style={{
                    minWidth: 70,
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 11,
                    color: 'var(--muted-foreground,#888)',
                  }}
                >
                  {f.id}
                </span>
                <span style={{ flex: 1, color: 'var(--foreground,#ccc)' }}>{f.title}</span>
                {f.needs_human_review && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: '1px 5px',
                      background: '#7c2d12',
                      color: '#fed7aa',
                      borderRadius: 2,
                    }}
                  >
                    review
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
