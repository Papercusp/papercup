'use client';

/**
 * CupboardModerationClient — operator moderation UI for the Cupboard registry
 * (Phase 9 D-002). Renders the abuse-report queue and lets a Cupboard operator
 * dismiss a report or take a listing down.
 *
 * Self-fetching (the admin-route pattern, like DbosClient): it hits the
 * operator's `/api/cupboard/admin/*` proxy, which forwards to the Cupboard
 * worker with the maintainer's gh-token added server-side. So this component
 * is framework-neutral — the operator-vite route at /admin/cupboard-moderation
 * consumes it via the `@/app` alias, the same way InsightsTab is mounted.
 *
 * Auth failures surface inline: 401 gh_auth_required (no gh login) and 403
 * (this account isn't in the worker's CUPBOARD_OPERATOR_GITHUB_IDS allowlist).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsStringLiteral } from 'nuqs';
import { toast } from 'sonner';
import { Flag, ExternalLink, RefreshCw, Shield } from 'lucide-react';

const STATUS_FILTERS = ['pending', 'resolved_unlist', 'resolved_dismiss', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

interface ReportRow {
  id: string;
  harness_id: string;
  reporter_github_login: string;
  reporter_github_user_id: number;
  reason: string;
  status: 'pending' | 'resolved_unlist' | 'resolved_dismiss';
  resolved_at: number | null;
  resolved_by_operator_note: string | null;
  created_at: number;
  harness_title: string | null;
  harness_github_url: string | null;
  harness_unlisted_at: number | null;
}

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

const STATUS_LABEL: Record<ReportRow['status'], string> = {
  pending: 'Pending',
  resolved_unlist: 'Unlisted',
  resolved_dismiss: 'Dismissed',
};

export default function CupboardModerationClient() {
  const [filter, setFilter] = useQueryState(
    'cb_status',
    parseAsStringLiteral(STATUS_FILTERS).withDefault('pending'),
  );
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cupboard/admin/reports?status=${encodeURIComponent(filter)}`);
      const data = (await res.json().catch(() => ({}))) as {
        reports?: ReportRow[];
        error?: string;
        reason?: string;
      };
      if (!res.ok) {
        if (res.status === 401) {
          setError('GitHub sign-in required — the operator needs a `gh auth login` token to moderate.');
        } else if (res.status === 403) {
          setError('This GitHub account is not a Cupboard operator (not in CUPBOARD_OPERATOR_GITHUB_IDS).');
        } else {
          setError(data.error ?? `HTTP ${res.status}`);
        }
        setReports([]);
        return;
      }
      setReports(data.reports ?? []);
    } catch (e) {
      setError(String(e));
      setReports([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (id: string, action: 'unlist' | 'dismiss') => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/cupboard/admin/reports/${encodeURIComponent(id)}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `HTTP ${res.status}`);
        }
        toast.success(action === 'unlist' ? 'Report resolved — listing taken down' : 'Report dismissed');
        void load();
      } catch (e) {
        toast.error(`Action failed: ${String(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <div className="pc-cbmod">
      <div className="pc-cbmod__bar">
        <span className="pc-cbmod__title">
          <Shield size={15} aria-hidden /> Cupboard moderation
        </span>
        <div className="pc-cbmod__filters" role="tablist" aria-label="Report status filter">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`pc-cbmod__chip${filter === f ? ' is-active' : ''}`}
              onClick={() => void setFilter(f)}
            >
              {f === 'all' ? 'all' : STATUS_LABEL[f as ReportRow['status']]}
            </button>
          ))}
        </div>
        <button type="button" className="pc-cbmod__refresh" onClick={() => void load()} aria-label="Refresh">
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>

      <div className="pc-cbmod__list">
        {loading ? (
          <div className="pc-cbmod__msg">Loading…</div>
        ) : error ? (
          <div className="pc-cbmod__msg pc-cbmod__msg--err">{error}</div>
        ) : reports.length === 0 ? (
          <div className="pc-cbmod__msg">
            {filter === 'pending' ? 'No pending reports — nothing to moderate.' : 'No reports match this filter.'}
          </div>
        ) : (
          reports.map((r) => (
            <div key={r.id} className="pc-cbmod__card">
              <div className="pc-cbmod__cardhead">
                <Flag size={13} aria-hidden className="pc-cbmod__flag" />
                <span className="pc-cbmod__harness">{r.harness_title ?? r.harness_id}</span>
                {r.harness_github_url && (
                  <a className="pc-cbmod__gh" href={r.harness_github_url} target="_blank" rel="noreferrer">
                    <ExternalLink size={12} aria-hidden /> repo
                  </a>
                )}
                <span className={`pc-cbmod__status pc-cbmod__status--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                {r.harness_unlisted_at && <span className="pc-cbmod__taken">listing down</span>}
              </div>
              <div className="pc-cbmod__reason">{r.reason}</div>
              <div className="pc-cbmod__meta">
                reported by <strong>@{r.reporter_github_login}</strong> · {fmtTime(r.created_at)}
                {r.status !== 'pending' && (
                  <> · resolved {fmtTime(r.resolved_at)}{r.resolved_by_operator_note ? ` — “${r.resolved_by_operator_note}”` : ''}</>
                )}
              </div>
              {r.status === 'pending' && (
                <div className="pc-cbmod__actions">
                  <button
                    type="button"
                    className="pc-cbmod__btn pc-cbmod__btn--dismiss"
                    disabled={busyId === r.id}
                    onClick={() => void resolve(r.id, 'dismiss')}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    className="pc-cbmod__btn pc-cbmod__btn--unlist"
                    disabled={busyId === r.id}
                    onClick={() => void resolve(r.id, 'unlist')}
                  >
                    Unlist harness
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <style>{`
        .pc-cbmod { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .pc-cbmod__bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 4px 12px; }
        .pc-cbmod__title { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--fg, #e7f7ff); }
        .pc-cbmod__title svg { color: var(--accent, #38bdf8); }
        .pc-cbmod__filters { display: inline-flex; gap: 5px; flex-wrap: wrap; }
        .pc-cbmod__chip { font-size: 11px; padding: 3px 10px; border-radius: 999px; border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 78%); background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer; text-transform: capitalize; }
        .pc-cbmod__chip:hover { color: var(--fg, #e7f7ff); }
        .pc-cbmod__chip.is-active { color: var(--fg, #e7f7ff); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 80%); border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 40%); }
        .pc-cbmod__refresh { margin-left: auto; display: inline-flex; align-items: center; padding: 5px; color: var(--fg-mute, #7f9bb4); background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
        .pc-cbmod__refresh:hover { color: var(--fg, #e7f7ff); }
        .pc-cbmod__list { flex: 1; min-height: 0; overflow: auto; display: grid; gap: 10px; align-content: start; }
        .pc-cbmod__msg { color: var(--fg-mute, #7f9bb4); font-size: 13px; padding: 24px; text-align: center; }
        .pc-cbmod__msg--err { color: var(--bad, #f87171); }
        .pc-cbmod__card { border: 1px solid var(--border, rgba(125,211,252,0.15)); border-radius: 8px; padding: 12px 14px; background: var(--bg-1, rgba(255,255,255,0.02)); }
        .pc-cbmod__cardhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-cbmod__flag { color: var(--bad, #f87171); }
        .pc-cbmod__harness { font-weight: 700; color: var(--fg, #e7f7ff); }
        .pc-cbmod__gh { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--accent, #38bdf8); text-decoration: none; }
        .pc-cbmod__gh:hover { text-decoration: underline; }
        .pc-cbmod__status { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 7px; border-radius: 999px; }
        .pc-cbmod__status--pending { color: #f59e0b; background: color-mix(in oklab, #f59e0b, transparent 84%); }
        .pc-cbmod__status--resolved_unlist { color: #f87171; background: color-mix(in oklab, #f87171, transparent 84%); }
        .pc-cbmod__status--resolved_dismiss { color: #22c55e; background: color-mix(in oklab, #22c55e, transparent 84%); }
        .pc-cbmod__taken { font-size: 10px; font-weight: 600; color: var(--bad, #f87171); }
        .pc-cbmod__reason { margin: 8px 0 6px; font-size: 13px; color: var(--fg, #e7f7ff); white-space: pre-wrap; }
        .pc-cbmod__meta { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
        .pc-cbmod__actions { display: flex; gap: 8px; margin-top: 10px; }
        .pc-cbmod__btn { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
        .pc-cbmod__btn:disabled { opacity: 0.5; cursor: default; }
        .pc-cbmod__btn--dismiss { background: transparent; color: var(--fg-mute, #7f9bb4); border-color: var(--border, rgba(125,211,252,0.2)); }
        .pc-cbmod__btn--dismiss:hover:not(:disabled) { color: var(--fg, #e7f7ff); }
        .pc-cbmod__btn--unlist { background: color-mix(in oklab, #f87171, transparent 86%); color: #f87171; border-color: color-mix(in oklab, #f87171, transparent 55%); }
        .pc-cbmod__btn--unlist:hover:not(:disabled) { background: color-mix(in oklab, #f87171, transparent 75%); }
      `}</style>
    </div>
  );
}
