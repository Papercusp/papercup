/**
 * RealIssuesPanel — issues list backed by /api/harness/<slug>/issues-list.
 *
 * Second real panel implementation. Demonstrates:
 *   - Independent fetch per panel instance (multi-slug compare)
 *   - Severity + status filter chips
 *   - Compact list with severity color coding
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PanelComponentProps } from './panel-registry';
import { openPanel, focusPanel } from './dock-actions';
import { useHarnessIssues } from '../../adv/harnesses/useHarnessData';
import { Tooltip } from '../Tooltip';

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'var(--bad)',
  major: '#ea580c',
  minor: 'var(--warn)',
  trivial: 'var(--fg-mute)',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--bad)',
  triaged: 'var(--warn)',
  fixing: '#60a5fa',
  fixed: 'var(--good)',
  closed: '#71717a',
  duplicate: '#71717a',
};

type Filter = 'all' | 'open' | 'triaged' | 'fixed' | 'closed';

export function RealIssuesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  // Live data via useHarnessIssues (REST bootstrap + consolidated sync
  // overlay) — replaces the one-shot fetch that left this panel stale
  // until reopen (audit P-058).
  const { issues, error } = useHarnessIssues(slug);
  const [filter, setFilter] = useState<Filter>('open');

  useEffect(() => {
    if (issues) api.setTitle(`Issues: ${slug} (${issues.length})`);
  }, [issues, slug, api]);

  const filtered = useMemo(() => {
    if (!issues) return [];
    if (filter === 'all') return issues;
    return issues.filter((i) => i.status === filter);
  }, [issues, filter]);

  const counts = useMemo(() => {
    if (!issues) return { all: 0, open: 0, triaged: 0, fixed: 0, closed: 0 };
    const acc = { all: issues.length, open: 0, triaged: 0, fixed: 0, closed: 0 };
    for (const i of issues) {
      const s = i.status ?? '';
      if (s in acc) (acc as Record<string, number>)[s] += 1;
    }
    return acc;
  }, [issues]);

  if (!slug) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug in params.
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--bad)' }}>Failed: {error}</div>
    );
  }
  if (!issues) {
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
        {(['all', 'open', 'triaged', 'fixed', 'closed'] as Filter[]).map((key) => {
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
              {key} ({counts[key]})
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontSize: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--fg-mute)' }}>
            No issues match.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {filtered.map((i) => (
              <Tooltip key={i.id} label="Cmd/Ctrl-click or right-click to pin as panel" side="right" align="start">
                <li
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const id = openPanel({
                      type: 'pin:issue',
                      params: { harnessSlug: slug, issueId: i.id },
                      title: i.id,
                    });
                    focusPanel(id);
                  }}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) {
                      const id = openPanel({
                        type: 'pin:issue',
                        params: { harnessSlug: slug, issueId: i.id },
                        title: i.id,
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
                    width: 6,
                    height: 18,
                    borderRadius: 1,
                    background: SEVERITY_COLORS[i.severity ?? ''] ?? '#444',
                    flexShrink: 0,
                  }}
                  title={`severity: ${i.severity ?? 'unknown'}`}
                />
                <span
                  style={{
                    minWidth: 60,
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 11,
                    color: 'var(--fg-mute)',
                  }}
                >
                  {i.id}
                </span>
                <span style={{ flex: 1, color: 'var(--fg)' }}>{i.title}</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    background: STATUS_COLORS[i.status ?? ''] ?? '#333',
                    color: '#111',
                    borderRadius: 2,
                    flexShrink: 0,
                  }}
                  title={`status: ${i.status ?? 'unknown'}`}
                >
                  {i.status ?? '?'}
                </span>
                </li>
              </Tooltip>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
