'use client';

import { useEffect, useMemo, useState } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import PinMenu, { type PinMenuState } from './PinMenu';

type FeatureStatus =
  | 'todo'
  | 'in_progress'
  | 'validating'
  | 'passed'
  | 'failing'
  | 'deprecated'
  | 'blocked';

interface Feature {
  id: string;
  title: string;
  status: FeatureStatus;
  attempts?: number;
  summary?: string;
  needs_human_review?: boolean;
}

interface StatusResponse {
  features: Feature[];
  counts: Record<string, number>;
}

// Saved views mirror the legacy FeatureList BUILT_IN_VIEWS. Each view is a
// predicate over a feature; counts are computed client-side. "Running" and
// "Blocked" group multiple statuses, "Stuck" keys off attempts (≥3) — the
// flat one-chip-per-status filter the panel shipped with couldn't express
// those. Deprecated features are hidden from every view except Deprecated.
type ViewId = 'all' | 'running' | 'stuck' | 'blocked' | 'todo' | 'passed' | 'deprecated';

const SAVED_VIEWS: Array<{ id: ViewId; label: string; match: (f: Feature) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'running', label: 'Running', match: (f) => f.status === 'in_progress' || f.status === 'validating' },
  { id: 'stuck', label: 'Stuck', match: (f) => (f.attempts ?? 0) >= 3 },
  { id: 'blocked', label: 'Blocked', match: (f) => f.status === 'blocked' || f.status === 'failing' },
  { id: 'todo', label: 'Todo', match: (f) => f.status === 'todo' },
  { id: 'passed', label: 'Passed', match: (f) => f.status === 'passed' },
  { id: 'deprecated', label: 'Deprecated', match: (f) => f.status === 'deprecated' },
];

// Sort order within a view, matching the legacy STATUS_ORDER intent
// (active work first, terminal states last).
const STATUS_ORDER: FeatureStatus[] = [
  'in_progress',
  'validating',
  'blocked',
  'failing',
  'todo',
  'passed',
  'deprecated',
];

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  passed: { bg: 'rgba(34, 197, 94, 0.14)', fg: '#86efac' },
  todo: { bg: 'rgba(148, 163, 184, 0.12)', fg: '#cbd5e1' },
  in_progress: { bg: 'rgba(96, 165, 250, 0.18)', fg: '#93c5fd' },
  failing: { bg: 'rgba(239, 68, 68, 0.16)', fg: '#fca5a5' },
  validating: { bg: 'rgba(250, 204, 21, 0.16)', fg: '#fde68a' },
  blocked: { bg: 'rgba(244, 114, 182, 0.16)', fg: '#f9a8d4' },
  deprecated: { bg: 'rgba(113, 113, 122, 0.18)', fg: '#a1a1aa' },
};

export default function FeaturesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Filter selection + search are user-meaningful → URL state (nuqs), not
  // useState, so the view is deep-linkable and agent-driveable. Keys are
  // feature-prefixed (fview/fq) so they don't collide with the Issues panel.
  const [view, setView] = useQueryState('fview', parseAsStringEnum<ViewId>(SAVED_VIEWS.map((v) => v.id)).withDefault('all'));
  const [search, setSearch] = useQueryState('fq', parseAsString.withDefault(''));
  const [selectedId, setSelectedId] = useQueryState('sel', parseAsString.withDefault(''));
  const [pinMenu, setPinMenu] = useState<PinMenuState | null>(null);

  useEffect(() => {
    if (!slug) {
      setData(null);
      return;
    }
    let cancel = false;
    const load = () => {
      setError(null);
      fetch(`/api/harness/${encodeURIComponent(slug)}/status?phase=staging`)
        .then((r) => {
          if (!r.ok) throw new Error(`status ${r.status}`);
          return r.json() as Promise<StatusResponse>;
        })
        .then((j) => {
          if (cancel) return;
          setData(j);
          api.setTitle(`Features · ${slug} (${j.features.length})`);
        })
        .catch((e: Error) => {
          if (cancel) return;
          setError(e);
        });
    };
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [slug, api]);

  const activeView = SAVED_VIEWS.find((v) => v.id === view) ?? SAVED_VIEWS[0];

  // Per-view counts (deprecated hidden everywhere except the Deprecated view).
  const viewCounts = useMemo(() => {
    const feats = data?.features ?? [];
    const out: Record<ViewId, number> = {
      all: 0, running: 0, stuck: 0, blocked: 0, todo: 0, passed: 0, deprecated: 0,
    };
    for (const v of SAVED_VIEWS) {
      out[v.id] = feats.filter((f) => {
        if (v.id !== 'deprecated' && f.status === 'deprecated') return false;
        return v.match(f);
      }).length;
    }
    return out;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const out = data.features.filter((f) => {
      if (activeView.id !== 'deprecated' && f.status === 'deprecated') return false;
      if (!activeView.match(f)) return false;
      if (!q) return true;
      return (
        f.id.toLowerCase().includes(q) ||
        f.title.toLowerCase().includes(q) ||
        (f.summary?.toLowerCase().includes(q) ?? false)
      );
    });
    return out.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
  }, [data, activeView, search]);

  if (!slug) {
    return <PanelMessage>Pick a harness to view its features.</PanelMessage>;
  }
  if (error) {
    return <PanelMessage tone="error">Failed to load features: {error.message}</PanelMessage>;
  }
  if (!data) {
    return <PanelMessage>Loading features…</PanelMessage>;
  }

  const total = data.features.length;

  return (
    <div className="pc-adv-features">
      <div className="pc-adv-features__bar">
        <input
          className="pc-adv-features__search"
          placeholder="Search features…"
          value={search}
          onChange={(e) => void setSearch(e.target.value || null)}
        />
        <div className="pc-adv-features__views" role="tablist" aria-label="Feature views">
          {SAVED_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={`pc-adv-features__view${view === v.id ? ' is-active' : ''}`}
              onClick={() => void setView(v.id === 'all' ? null : v.id)}
            >
              {v.label}
              <span>{viewCounts[v.id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="pc-adv-features__list">
        {filtered.length === 0 ? (
          <PanelMessage>
            {total === 0 ? 'No features yet — planner may still be running.' : 'No features match this view.'}
          </PanelMessage>
        ) : (
          filtered.map((f) => {
            const tone = STATUS_TONE[f.status] ?? STATUS_TONE.todo;
            const isActive = f.id === selectedId;
            const attempts = f.attempts ?? 0;
            return (
              <div
                key={f.id}
                className={`pc-adv-features__row${isActive ? ' is-active' : ''}`}
                onClick={() => void setSelectedId(f.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPinMenu({
                    pos: { x: e.clientX, y: e.clientY },
                    itemId: f.id,
                    itemLabel: f.id,
                    harnessSlug: slug,
                  });
                }}
                role="button"
                tabIndex={0}
              >
                <span className="pc-adv-features__id">{f.id}</span>
                <span
                  className="pc-adv-features__status"
                  style={{ background: tone.bg, color: tone.fg }}
                >
                  {f.status}
                </span>
                <span className="pc-adv-features__title">
                  {f.needs_human_review && (
                    <span className="pc-adv-features__review" title="Needs human review" aria-label="Needs human review" />
                  )}
                  {f.title}
                </span>
                {attempts > 0 && (
                  <span
                    className={`pc-adv-features__attempts${attempts >= 3 ? ' is-warn' : ''}`}
                    title={`${attempts} attempt${attempts === 1 ? '' : 's'}`}
                  >
                    ×{attempts}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="pc-adv-features__footer">
        <span>{filtered.length}/{total} shown</span>
      </div>
      <style>{`
        .pc-adv-features {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          background: rgba(8, 10, 22, 0.6);
        }
        .pc-adv-features__bar {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid rgba(167, 139, 250, 0.12);
          flex-wrap: wrap;
        }
        .pc-adv-features__search {
          flex: 1;
          min-width: 160px;
          padding: 6px 8px;
          font-size: 12px;
          background: rgba(20, 18, 38, 0.96);
          color: #f7f5ff;
          border: 1px solid rgba(167, 139, 250, 0.2);
          border-radius: 6px;
        }
        .pc-adv-features__views {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }
        .pc-adv-features__view {
          display: inline-flex;
          gap: 6px;
          align-items: center;
          padding: 4px 8px;
          font-size: 11px;
          font-weight: 600;
          color: rgba(220, 214, 248, 0.66);
          background: rgba(20, 18, 38, 0.6);
          border: 1px solid rgba(167, 139, 250, 0.14);
          border-radius: 4px;
          cursor: pointer;
        }
        .pc-adv-features__view span {
          color: rgba(220, 214, 248, 0.5);
          font-weight: 700;
        }
        .pc-adv-features__view.is-active {
          color: #f7f5ff;
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.4);
        }
        .pc-adv-features__view.is-active span {
          color: #c4b5fd;
        }
        .pc-adv-features__list {
          flex: 1;
          overflow: auto;
          padding: 4px 0;
        }
        .pc-adv-features__row {
          display: grid;
          grid-template-columns: 78px 100px 1fr auto;
          gap: 10px;
          align-items: center;
          padding: 6px 12px;
          font-size: 12px;
          color: rgba(220, 214, 248, 0.86);
          border-bottom: 1px solid rgba(167, 139, 250, 0.06);
          cursor: pointer;
          user-select: none;
        }
        .pc-adv-features__row:hover {
          background: rgba(31, 23, 56, 0.45);
        }
        .pc-adv-features__row.is-active {
          background: rgba(167, 139, 250, 0.18);
          border-left: 2px solid rgba(167, 139, 250, 0.78);
          padding-left: 10px;
        }
        .pc-adv-features__id {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: rgba(199, 188, 252, 0.78);
          font-weight: 600;
        }
        .pc-adv-features__status {
          display: inline-block;
          padding: 1px 8px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          border-radius: 999px;
          text-align: center;
        }
        .pc-adv-features__title {
          display: inline-flex;
          gap: 7px;
          align-items: center;
          color: #f7f5ff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-features__review {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #fbbf24;
          flex-shrink: 0;
          box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.2);
        }
        .pc-adv-features__attempts {
          font-size: 10px;
          font-weight: 700;
          color: rgba(220, 214, 248, 0.54);
        }
        .pc-adv-features__attempts.is-warn {
          color: #fca5a5;
          background: rgba(239, 68, 68, 0.14);
          padding: 1px 6px;
          border-radius: 999px;
        }
        .pc-adv-features__footer {
          flex-shrink: 0;
          padding: 4px 12px;
          font-size: 10px;
          color: rgba(220, 214, 248, 0.5);
          border-top: 1px solid rgba(167, 139, 250, 0.08);
        }
      `}</style>
      <PinMenu state={pinMenu} onClose={() => setPinMenu(null)} />
    </div>
  );
}

function PanelMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'error';
}) {
  return (
    <div
      style={{
        padding: '24px',
        textAlign: 'center',
        color: tone === 'error' ? '#fca5a5' : 'rgba(220, 214, 248, 0.6)',
        fontSize: 13,
        height: '100%',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {children}
    </div>
  );
}
