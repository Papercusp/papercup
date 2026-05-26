'use client';

import { useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import type { Issue, IssueSeverity, IssueStatus } from '../../harness/issues/types';
import PinMenu, { type PinMenuState } from './PinMenu';

interface IssuesListResponse {
  issues: Issue[];
  nextId?: number;
  pending?: Array<Partial<Issue> & { title: string }>;
}

const STATUS_FILTERS: Array<{ key: 'all' | IssueStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'acknowledged', label: 'Ack' },
  { key: 'fixing', label: 'Fixing' },
  { key: 'closed', label: 'Closed' },
  { key: 'wontfix', label: 'Won’t fix' },
];

const SEVERITY_TONE: Record<IssueSeverity, { bg: string; fg: string }> = {
  critical: { bg: 'rgba(239, 68, 68, 0.18)', fg: '#fca5a5' },
  major: { bg: 'rgba(249, 115, 22, 0.16)', fg: '#fdba74' },
  minor: { bg: 'rgba(250, 204, 21, 0.14)', fg: '#fde68a' },
  nit: { bg: 'rgba(148, 163, 184, 0.14)', fg: '#cbd5e1' },
};

const STATUS_DOT: Record<IssueStatus, string> = {
  open: '#fca5a5',
  acknowledged: '#fde68a',
  fixing: '#c4b5fd',
  closed: '#86efac',
  wontfix: '#71717a',
};

export default function IssuesPanel({ params, api }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || '';
  const [data, setData] = useState<IssuesListResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]['key']>('open');
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
      fetch(`/api/harness/${encodeURIComponent(slug)}/issues-list?phase=staging`)
        .then((r) => {
          if (!r.ok) throw new Error(`issues-list ${r.status}`);
          return r.json() as Promise<IssuesListResponse>;
        })
        .then((j) => {
          if (cancel) return;
          setData(j);
          api.setTitle(`Issues · ${slug} (${j.issues?.length ?? 0})`);
        })
        .catch((e: Error) => {
          if (cancel) return;
          setError(e);
        });
    };
    load();
    const id = window.setInterval(load, 6000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [slug, api]);

  const filtered = useMemo(() => {
    if (!data?.issues) return [];
    const q = search.trim().toLowerCase();
    return data.issues.filter((i) => {
      if (filter !== 'all' && i.status !== filter) return false;
      if (!q) return true;
      return (
        i.id.toLowerCase().includes(q) ||
        i.title.toLowerCase().includes(q) ||
        (i.evidence?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [data, filter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.issues.length ?? 0 };
    for (const i of data?.issues ?? []) {
      c[i.status] = (c[i.status] ?? 0) + 1;
    }
    return c;
  }, [data]);

  const pendingCount = data?.pending?.length ?? 0;

  if (!slug) {
    return <PanelMessage>Pick a harness to view its issues.</PanelMessage>;
  }
  if (error) {
    return <PanelMessage tone="error">Failed to load issues: {error.message}</PanelMessage>;
  }
  if (!data) {
    return <PanelMessage>Loading issues…</PanelMessage>;
  }

  return (
    <div className="pc-adv-issues">
      <div className="pc-adv-issues__bar">
        <input
          className="pc-adv-issues__search"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="pc-adv-issues__filters">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`pc-adv-issues__filter${filter === f.key ? ' is-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span>{counts[f.key] ?? 0}</span>
            </button>
          ))}
          {pendingCount > 0 && (
            <span className="pc-adv-issues__pending" title="pending validator findings awaiting triage">
              pending <strong>{pendingCount}</strong>
            </span>
          )}
        </div>
      </div>
      <div className="pc-adv-issues__list">
        {filtered.length === 0 ? (
          <PanelMessage>No issues match the current filter.</PanelMessage>
        ) : (
          filtered.map((i) => {
            const sevTone = SEVERITY_TONE[i.severity] ?? SEVERITY_TONE.minor;
            const isActive = i.id === selectedId;
            return (
              <div
                key={i.id}
                className={`pc-adv-issues__row${isActive ? ' is-active' : ''}`}
                onClick={() => void setSelectedId(i.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPinMenu({
                    pos: { x: e.clientX, y: e.clientY },
                    itemId: i.id,
                    itemLabel: i.id,
                    harnessSlug: slug,
                  });
                }}
                role="button"
                tabIndex={0}
              >
                <span className="pc-adv-issues__id">{i.id}</span>
                <span
                  className="pc-adv-issues__severity"
                  style={{ background: sevTone.bg, color: sevTone.fg }}
                >
                  {i.severity}
                </span>
                <span className="pc-adv-issues__title">
                  <span
                    className="pc-adv-issues__dot"
                    style={{ background: STATUS_DOT[i.status] ?? '#888' }}
                    title={i.status}
                  />
                  {i.title}
                </span>
                {i.linkedFeatureId && (
                  <span className="pc-adv-issues__link" title="linked feature">
                    {i.linkedFeatureId}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
      <style>{`
        .pc-adv-issues {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          background: rgba(8, 10, 22, 0.6);
        }
        .pc-adv-issues__bar {
          display: flex;
          gap: 12px;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid rgba(167, 139, 250, 0.12);
          flex-wrap: wrap;
        }
        .pc-adv-issues__search {
          flex: 1;
          min-width: 160px;
          padding: 6px 8px;
          font-size: 12px;
          background: rgba(20, 18, 38, 0.96);
          color: #f7f5ff;
          border: 1px solid rgba(167, 139, 250, 0.2);
          border-radius: 6px;
        }
        .pc-adv-issues__filters {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          align-items: center;
        }
        .pc-adv-issues__filter {
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
        .pc-adv-issues__filter span {
          color: rgba(220, 214, 248, 0.5);
          font-weight: 700;
        }
        .pc-adv-issues__filter.is-active {
          color: #f7f5ff;
          background: rgba(31, 23, 56, 0.96);
          border-color: rgba(167, 139, 250, 0.4);
        }
        .pc-adv-issues__filter.is-active span {
          color: #c4b5fd;
        }
        .pc-adv-issues__pending {
          font-size: 10px;
          color: rgba(220, 214, 248, 0.6);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          padding: 4px 8px;
          border-radius: 4px;
          background: rgba(250, 204, 21, 0.08);
          border: 1px solid rgba(250, 204, 21, 0.24);
        }
        .pc-adv-issues__pending strong {
          color: #fde68a;
          font-weight: 700;
        }
        .pc-adv-issues__list {
          flex: 1;
          overflow: auto;
          padding: 4px 0;
        }
        .pc-adv-issues__row {
          display: grid;
          grid-template-columns: 78px 80px 1fr auto;
          gap: 10px;
          align-items: center;
          padding: 6px 12px;
          font-size: 12px;
          color: rgba(220, 214, 248, 0.86);
          border-bottom: 1px solid rgba(167, 139, 250, 0.06);
        }
        .pc-adv-issues__row {
          cursor: pointer;
          user-select: none;
        }
        .pc-adv-issues__row:hover {
          background: rgba(31, 23, 56, 0.45);
        }
        .pc-adv-issues__row.is-active {
          background: rgba(167, 139, 250, 0.18);
          border-left: 2px solid rgba(167, 139, 250, 0.78);
          padding-left: 10px;
        }
        .pc-adv-issues__id {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          color: rgba(199, 188, 252, 0.78);
          font-weight: 600;
        }
        .pc-adv-issues__severity {
          display: inline-block;
          padding: 1px 8px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          border-radius: 999px;
          text-align: center;
        }
        .pc-adv-issues__title {
          display: inline-flex;
          gap: 8px;
          align-items: center;
          color: #f7f5ff;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pc-adv-issues__dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .pc-adv-issues__link {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 10px;
          color: rgba(199, 188, 252, 0.66);
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
