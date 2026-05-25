'use client';

/**
 * PrsTab — PRs tab for the harness UI (Phase 7 P-043).
 *
 * P-043a: each row shows PR number+title, author, checks, reviews, trust badge.
 * P-043b: action buttons — Open on GitHub (always), Approve, Approve+merge.
 * P-043c: filter chips — all, mine, awaiting-me, approved, merged.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import { toast } from 'sonner';
import { GitPullRequest, RefreshCw } from 'lucide-react';
import { COLORS, FONTS, RADIUS, SIZES } from './theme';
import { PrRow, type PrRowData } from './PrRow';

const PR_FILTERS = ['all', 'mine', 'awaiting-me', 'approved', 'merged'] as const;
type PrFilter = (typeof PR_FILTERS)[number];

interface Props {
  harnessSlug: string;
  /** GitHub user id of the current viewer. */
  viewerGithubId?: number;
  viewerLogin?: string;
  /** Trust list for the viewer on this harness. */
  trustedAuthorIds?: ReadonlySet<number>;
  reviewerRoleEnabled?: boolean;
}

interface PrsResponse {
  prs: PrRowData[];
  pollingFailedAt?: string | null;
}

async function fetchPrs(harnessSlug: string): Promise<PrsResponse> {
  const r = await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/prs`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<PrsResponse>;
}

async function postApprove(harnessSlug: string, prNumber: number, merge: boolean): Promise<void> {
  const r = await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/prs/${prNumber}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: merge ? 'approve_and_merge' : 'approve' }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
}

export function PrsTab({
  harnessSlug,
  viewerGithubId,
  trustedAuthorIds = new Set(),
  reviewerRoleEnabled = false,
}: Props) {
  const [filter, setFilter] = useQueryState(
    'prs_filter',
    parseAsStringLiteral(PR_FILTERS).withDefault('all'),
  );
  const [prs, setPrs] = useState<PrRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingFailed, setPollingFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchPrs(harnessSlug);
      const enriched = resp.prs.map((pr) => ({
        ...pr,
        trusted: trustedAuthorIds.has(pr.author_github_id),
        reviewerRoleEnabled,
      }));
      setPrs(enriched);
      setPollingFailed(!!resp.pollingFailedAt);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [harnessSlug, trustedAuthorIds, reviewerRoleEnabled]);

  useEffect(() => { void load(); }, [load]);

  const handleApprove = useCallback(async (prNumber: number, merge: boolean) => {
    try {
      await postApprove(harnessSlug, prNumber, merge);
      toast.success(merge ? `Approved + merged PR #${prNumber}` : `Approved PR #${prNumber}`);
      void load();
    } catch (e) {
      toast.error(`Action failed: ${String(e)}`);
    }
  }, [harnessSlug, load]);

  const displayed = prs.filter((pr) => {
    if (filter === 'all') return pr.state !== 'gone';
    if (filter === 'mine') return pr.author_github_id === viewerGithubId && pr.state === 'open';
    if (filter === 'awaiting-me') return pr.review_decision === 'none' && pr.state === 'open';
    if (filter === 'approved') return pr.review_decision === 'approved';
    if (filter === 'merged') return pr.state === 'merged';
    return true;
  });

  return (
    <div style={{ padding: 20, fontFamily: FONTS.ui }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <GitPullRequest size={16} color={COLORS.accent} />
          <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.text }}>Pull Requests</span>
          {pollingFailed && (
            <span style={{ fontSize: 11, color: COLORS.dangerText, marginLeft: 4 }}>
              cannot reach GitHub
            </span>
          )}
        </div>
        <button
          onClick={() => void load()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.textMuted, padding: 4 }}
          aria-label="Refresh PRs"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Filter chips — P-043c */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {PR_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => void setFilter(f)}
            style={{
              fontSize: 12,
              padding: '3px 10px',
              borderRadius: 999,
              border: `1px solid ${filter === f ? COLORS.accent : COLORS.border}`,
              background: filter === f ? COLORS.accent : 'transparent',
              color: filter === f ? '#fff' : COLORS.textMuted,
              cursor: 'pointer',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* PR list */}
      {loading && (
        <div style={{ color: COLORS.textMuted, fontSize: 13 }}>Loading…</div>
      )}
      {!loading && error && (
        <div style={{ color: COLORS.dangerText, fontSize: 13 }}>{error}</div>
      )}
      {!loading && !error && displayed.length === 0 && (
        <div style={{ color: COLORS.textMuted, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>
          No PRs match this filter.
        </div>
      )}
      {!loading && !error && displayed.map((pr) => (
        <PrRow
          key={`${pr.remote}#${pr.number}`}
          pr={pr}
          onApprove={(n) => void handleApprove(n, false)}
          onApproveAndMerge={(n) => void handleApprove(n, true)}
        />
      ))}
    </div>
  );
}

export default PrsTab;
