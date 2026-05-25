'use client';

/**
 * ContributorsTab — Phase 8 P-048 assembly.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.2 + addendum 3.
 *
 * Loads contributors from `/api/harness/:slug/contributors` (PG-backed
 * via the projection layer) and renders a sortable list. Empty-state
 * surfaces the share-this-harness CTA per the addendum-3 "new harness,
 * one contributor" experience.
 *
 * Sort key (P-048c) is URL-backed via nuqs so back/forward + share
 * link both preserve the sort. Visual grouping by tier is intentional
 * — the column hint above the list explains what `joined` / `prs` /
 * `features` / `events` mean and which tier each falls into.
 *
 * P-048d: unverified contributors render greyed-out via ContributorRow.
 */

import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import { Users, RefreshCw } from 'lucide-react';
import { ContributorRow, type ContributorRowData } from './ContributorRow';

const SORTS = ['joined', 'prs', 'features', 'events'] as const;
type SortKey = (typeof SORTS)[number];

export interface ContributorsTabProps {
  harnessSlug: string;
}

interface ListResponse {
  contributors: ContributorRowData[];
}

async function fetchList(slug: string): Promise<ContributorRowData[]> {
  const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/contributors`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = (await r.json()) as ListResponse;
  return body.contributors ?? [];
}

function sortBy(rows: ContributorRowData[], key: SortKey): ContributorRowData[] {
  const copy = [...rows];
  switch (key) {
    case 'joined':
      copy.sort((a, b) => b.joined_at - a.joined_at);
      return copy;
    case 'prs':
      copy.sort((a, b) => b.prs_merged - a.prs_merged);
      return copy;
    case 'features':
      copy.sort((a, b) => b.features_shipped - a.features_shipped);
      return copy;
    case 'events':
      copy.sort((a, b) => b.activity_events - a.activity_events);
      return copy;
  }
}

const SORT_LABELS: Record<SortKey, { label: string; tier: string }> = {
  joined: { label: 'joined', tier: '' },
  prs: { label: 'PRs merged', tier: '✓ A' },
  features: { label: 'features shipped', tier: '✓ B' },
  events: { label: 'activity', tier: 'C' },
};

export function ContributorsTab({ harnessSlug }: ContributorsTabProps) {
  const [sortKey, setSortKey] = useQueryState(
    'sort',
    parseAsStringLiteral(SORTS).withDefault('joined'),
  );
  const [rows, setRows] = useState<ContributorRowData[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchList(harnessSlug);
      setRows(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, [harnessSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = sortBy(rows, sortKey);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Users size={16} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Contributors</span>
        <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
          {loading ? 'loading…' : `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`}
        </span>

        <span style={{ flex: 1 }} />

        <span style={{ color: 'var(--fg-dim)', fontSize: 12, marginRight: 4 }}>
          sort by
        </span>
        {SORTS.map((k) => {
          const active = sortKey === k;
          return (
            <button
              key={k}
              onClick={() => void setSortKey(k)}
              data-active={active}
              style={{
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'inherit',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '2px 8px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {SORT_LABELS[k].label}
              {SORT_LABELS[k].tier ? (
                <span style={{ marginLeft: 4, opacity: 0.7 }}>
                  {SORT_LABELS[k].tier}
                </span>
              ) : null}
            </button>
          );
        })}

        <button
          onClick={() => void refresh()}
          title="Refresh"
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '4px 6px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {error ? (
        <div style={{ padding: 16, color: 'var(--danger, #c33)', fontSize: 13 }}>
          Failed to load: {error}
        </div>
      ) : !loading && rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-dim)' }}>
          <p style={{ fontSize: 14 }}>No contributors yet.</p>
          <p style={{ fontSize: 12, marginTop: 4 }}>
            Use <strong>Share this harness</strong> in the harness menu to invite collaborators.
          </p>
        </div>
      ) : (
        <div>
          {sorted.map((row) => (
            <ContributorRow key={row.github_user_id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
