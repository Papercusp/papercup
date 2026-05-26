'use client';

import { useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import PinMenu, { type PinMenuState } from './PinMenu';

type FeatureStatus = 'todo' | 'validating' | 'passed' | 'failing' | 'deprecated' | 'blocked';

interface Feature {
  id: string;
  title: string;
  status: FeatureStatus;
  attempts?: number;
  summary?: string;
}

interface StatusResponse {
  features: Feature[];
  counts: Record<string, number>;
}

const FILTERS: Array<{ key: 'all' | FeatureStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'todo', label: 'Todo' },
  { key: 'validating', label: 'Validating' },
  { key: 'passed', label: 'Passed' },
  { key: 'failing', label: 'Failing' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'deprecated', label: 'Deprecated' },
];

const STATUS_TONE: Record<string, { bg: string; fg: string }> = {
  passed: { bg: 'rgba(34, 197, 94, 0.14)', fg: '#86efac' },
  todo: { bg: 'rgba(148, 163, 184, 0.12)', fg: '#cbd5e1' },
  failing: { bg: 'rgba(239, 68, 68, 0.16)', fg: '#fca5a5' },
  validating: { bg: 'rgba(250, 204, 21, 0.16)', fg: '#fde68a' },
  blocked: { bg: 'rgba(244, 114, 182, 0.16)', fg: '#f9a8d4' },
  deprecated: { bg: 'rgba(113, 113, 122, 0.18)', fg: '#a1a1aa' },
};

export default function FeaturesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [search, setSearch] = useState('');
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

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.features.filter((f) => {
      if (filter !== 'all' && f.status !== filter) return false;
      if (!q) return true;
      return (
        f.id.toLowerCase().includes(q) ||
        f.title.toLowerCase().includes(q) ||
        (f.summary?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [data, filter, search]);

  if (!slug) {
    return <PanelMessage>Pick a harness to view its features.</PanelMessage>;
  }
  if (error) {
    return <PanelMessage tone="error">Failed to load features: {error.message}</PanelMessage>;
  }
  if (!data) {
    return <PanelMessage>Loading features…</PanelMessage>;
  }

  return (
    <div className="pc-adv-features">
      <div className="pc-adv-features__bar">
        <input
          className="pc-adv-features__search"
          placeholder="Search features…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="pc-adv-features__filters">
          {FILTERS.map((f) => {
            const count =
              f.key === 'all'
                ? data.features.length
                : (data.counts?.[f.key] ?? data.features.filter((x) => x.status === f.key).length);
            return (
              <button
                key={f.key}
                type="button"
                className={`pc-adv-features__filter${filter === f.key ? ' is-active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span>{count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="pc-adv-features__list">
        {filtered.length === 0 ? (
          <PanelMessage>No features match the current filter.</PanelMessage>
        ) : (
          filtered.map((f) => {
            const tone = STATUS_TONE[f.status] ?? STATUS_TONE.todo;
            const isActive = f.id === selectedId;
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
                <span className="pc-adv-features__title">{f.title}</span>
                {typeof f.attempts === 'number' && f.attempts > 0 && (
                  <span className="pc-adv-features__attempts" title="attempts">
                    {f.attempts}×
                  </span>
                )}
              </div>
            );
          })
        )}
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
        .pc-adv-features__filters {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }
        .pc-adv-features__filter {
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
        .pc-adv-features__filter span {
          color: rgba(220, 214, 248, 0.5);
          font-weight: 700;
        }
        .pc-adv-features__filter.is-active {
          color: #f7f5ff;
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.4);
        }
        .pc-adv-features__filter.is-active span {
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
        }
        .pc-adv-features__row {
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
          color: #f7f5ff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-features__attempts {
          font-size: 10px;
          color: rgba(220, 214, 248, 0.54);
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
