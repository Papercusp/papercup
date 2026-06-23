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
import { useHarnessFeatures } from '../../adv/harnesses/useHarnessData';
import { Tooltip } from '../Tooltip';

type FilterKey = 'all' | 'todo' | 'failing' | 'validating' | 'passed' | 'deprecated';

const STATUS_COLORS: Record<string, string> = {
  passed: 'var(--good)',
  todo: 'var(--fg-mute)',
  failing: 'var(--bad)',
  validating: 'var(--warn)',
  deprecated: '#71717a',
};

export function RealFeaturesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  // Live data via useHarnessFeatures (REST bootstrap + consolidated sync
  // overlay) — replaces the one-shot fetch that left this panel stale
  // until reopen (audit P-058).
  const { features, error } = useHarnessFeatures(slug);
  const [filter, setFilter] = useState<FilterKey>('all');

  useEffect(() => {
    // Update panel title with slug + count so multiple instances are
    // distinguishable in the tab strip.
    if (features) api.setTitle(`Features: ${slug} (${features.length})`);
  }, [features, slug, api]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of features ?? []) out[f.status] = (out[f.status] ?? 0) + 1;
    return out;
  }, [features]);

  const filtered = useMemo(() => {
    if (!features) return [];
    if (filter === 'all') return features;
    return features.filter((f) => f.status === filter);
  }, [features, filter]);

  if (!slug) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug in params. Open this panel via the dock toolbar with a slug.
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--bad)' }}>
        Failed: {error}
      </div>
    );
  }

  if (!features) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
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
          background: 'var(--bg-2)',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        {(['all', 'todo', 'failing', 'validating', 'passed', 'deprecated'] as FilterKey[]).map(
          (key) => {
            const count =
              key === 'all'
                ? features.length
                : (counts[key] ?? 0);
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
                  color: active ? 'var(--fg)' : 'var(--fg-mute)',
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
          <div style={{ padding: 16, color: 'var(--fg-mute)' }}>
            No features match.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {filtered.map((f) => (
              <Tooltip key={f.id} label="Cmd/Ctrl-click or right-click to pin as panel" side="right" align="start">
                <li
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
                  style={{
                    display: 'flex',
                    gap: 8,
                    padding: '6px 12px',
                    borderBottom: '1px solid var(--border)',
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
                    color: 'var(--fg-mute)',
                  }}
                >
                  {f.id}
                </span>
                <span style={{ flex: 1, color: 'var(--fg)' }}>{f.title}</span>
                {f.needsReview && (
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
              </Tooltip>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
