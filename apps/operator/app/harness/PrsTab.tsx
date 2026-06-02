'use client';

/**
 * PrsTab — PRs tab for the harness UI (Phase 7 P-043).
 *
 * P-043a: each row shows PR number+title, author, checks, reviews, trust badge.
 * P-043b: action buttons — Open on GitHub (always), Approve, Approve+merge.
 * P-043c: filter chips — all, mine, awaiting-me, approved, merged.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsStringLiteral, parseAsBoolean } from 'nuqs';
import { toast } from 'sonner';
import { GitPullRequest, RefreshCw, Settings } from 'lucide-react';
import { PrRow, type PrRowData } from './PrRow';
import { PrReviewerSettings } from './PrReviewerSettings';

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
  /** #5: server couldn't resolve a GitHub remote for this harness. */
  noRemote?: boolean;
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
  // Modal-open is user-meaningful URL state (deep-linkable, agent-driveable)
  // → nuqs. The setting VALUES are server state, kept in the modal's useState.
  const [settingsOpen, setSettingsOpen] = useQueryState(
    'prs_settings',
    parseAsBoolean.withDefault(false),
  );
  const [prs, setPrs] = useState<PrRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingFailed, setPollingFailed] = useState(false);
  const [noRemote, setNoRemote] = useState(false);

  // Fetch RAW prs only — keyed solely on harnessSlug. The per-row `trusted` /
  // `reviewerRoleEnabled` enrichment is intentionally NOT done here: folding it
  // into `load` made `load` depend on `trustedAuthorIds`, whose default value
  // (`new Set()`) is a fresh reference every render, so `useEffect([load])`
  // re-fired on every render — an infinite reload loop that stormed
  // /api/harness/<slug>/prs (observed: 194 requests from a single mount) and
  // wedged the webview connection pool, leaving the panel stuck on "Loading…".
  // Enrichment now lives in the `displayed` memo below, off the fetch path.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchPrs(harnessSlug);
      setPrs(resp.prs);
      setPollingFailed(!!resp.pollingFailedAt);
      setNoRemote(!!resp.noRemote);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [harnessSlug]);

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

  // Filter + enrich at render time (cheap, no setState/fetch — so a fresh
  // `trustedAuthorIds` reference each render only recomputes this memo, it never
  // re-triggers the loader). Enrichment stamps the per-row `trusted` /
  // `reviewerRoleEnabled` fields PrRow needs.
  const displayed = useMemo(
    () =>
      prs
        .filter((pr) => {
          if (filter === 'all') return pr.state !== 'gone';
          if (filter === 'mine') return pr.author_github_id === viewerGithubId && pr.state === 'open';
          if (filter === 'awaiting-me') return pr.review_decision === 'none' && pr.state === 'open';
          if (filter === 'approved') return pr.review_decision === 'approved';
          if (filter === 'merged') return pr.state === 'merged';
          return true;
        })
        .map((pr) => ({
          ...pr,
          trusted: trustedAuthorIds.has(pr.author_github_id),
          reviewerRoleEnabled,
        })),
    [prs, filter, viewerGithubId, trustedAuthorIds, reviewerRoleEnabled],
  );

  return (
    <div className="pc-adv-prs">
      <div className="pc-adv-prs__bar">
        <span className="pc-adv-prs__title">
          <GitPullRequest size={14} aria-hidden />
          Pull requests
          {pollingFailed && <span className="pc-adv-prs__warn">cannot reach GitHub</span>}
        </span>
        <div className="pc-adv-prs__filters" role="tablist" aria-label="PR filters">
          {PR_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`pc-adv-prs__chip pc-adv-prs__chip--${f}${filter === f ? ' is-active' : ''}`}
              onClick={() => void setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="pc-adv-prs__refresh"
          onClick={() => void load()}
          aria-label="Refresh PRs"
        >
          <RefreshCw size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="pc-adv-prs__settings"
          onClick={() => void setSettingsOpen(true)}
          aria-label="PR-reviewer settings"
        >
          <Settings size={13} aria-hidden />
        </button>
      </div>

      <div className="pc-adv-prs__list">
        {loading ? (
          <div className="pc-adv-prs__msg">Loading…</div>
        ) : error ? (
          <div className="pc-adv-prs__msg pc-adv-prs__msg--err">{error}</div>
        ) : displayed.length === 0 ? (
          <div className="pc-adv-prs__msg">
            {noRemote
              ? 'No GitHub remote configured for this harness — link a GitHub repo to see its pull requests.'
              : 'No PRs match this filter.'}
          </div>
        ) : (
          displayed.map((pr) => (
            <PrRow
              key={`${pr.remote}#${pr.number}`}
              pr={pr}
              onApprove={(n) => void handleApprove(n, false)}
              onApproveAndMerge={(n) => void handleApprove(n, true)}
            />
          ))
        )}
      </div>

      <style>{`
        .pc-adv-prs { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-1, #0b1220); }
        .pc-adv-prs__bar {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
          padding: 6px 10px; flex-shrink: 0;
          border-bottom: 1px solid var(--border, rgba(125, 211, 252, 0.15));
        }
        .pc-adv-prs__title {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 12px; font-weight: 700; color: var(--fg, #e7f7ff);
        }
        .pc-adv-prs__title svg { color: var(--accent, #38bdf8); }
        .pc-adv-prs__warn { font-size: 10px; font-weight: 600; color: var(--bad, #f87171); }
        .pc-adv-prs__filters { display: inline-flex; gap: 4px; flex-wrap: wrap; }
        /* Per-filter tints: each chip carries a --chip-tint (faint on the idle
           border, strong fill when active) so the PR filters are colour-coded —
           sky=all, blue=mine, amber=awaiting, green=approved, violet=merged. */
        .pc-adv-prs__chip {
          --chip-tint: var(--accent, #38bdf8);
          font-size: 11px; padding: 2px 9px; border-radius: 999px;
          border: 1px solid color-mix(in oklab, var(--chip-tint), transparent 80%);
          background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer;
          text-transform: capitalize;
          transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .pc-adv-prs__chip--all { --chip-tint: #7dd3fc; }
        .pc-adv-prs__chip--mine { --chip-tint: #38bdf8; }
        .pc-adv-prs__chip--awaiting-me { --chip-tint: #f59e0b; }
        .pc-adv-prs__chip--approved { --chip-tint: #22c55e; }
        .pc-adv-prs__chip--merged { --chip-tint: #a78bfa; }
        .pc-adv-prs__chip:hover { color: var(--fg, #e7f7ff); border-color: color-mix(in oklab, var(--chip-tint), transparent 45%); }
        .pc-adv-prs__chip.is-active {
          color: var(--fg, #e7f7ff);
          background: color-mix(in oklab, var(--chip-tint), transparent 80%);
          border-color: color-mix(in oklab, var(--chip-tint), transparent 38%);
        }
        .pc-adv-prs__refresh {
          margin-left: auto; display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute, #7f9bb4); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-prs__refresh:hover { color: var(--fg, #e7f7ff); }
        .pc-adv-prs__settings {
          display: inline-flex; align-items: center; padding: 4px;
          color: var(--fg-mute, #7f9bb4); background: transparent; border: 0; border-radius: 4px; cursor: pointer;
        }
        .pc-adv-prs__settings:hover { color: var(--fg, #e7f7ff); }
        .pc-adv-prs__list {
          flex: 1; min-height: 0; overflow: auto;
          padding: 10px 12px; display: grid; gap: 8px; align-content: start;
        }
        .pc-adv-prs__msg { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 16px; text-align: center; }
        .pc-adv-prs__msg--err { color: var(--bad, #f87171); }
      `}</style>

      <PrReviewerSettings
        harnessSlug={harnessSlug}
        open={settingsOpen}
        onOpenChange={(o) => void setSettingsOpen(o)}
      />
    </div>
  );
}

export default PrsTab;
