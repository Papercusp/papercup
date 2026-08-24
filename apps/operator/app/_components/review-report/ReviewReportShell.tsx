'use client';

/**
 * ReviewReportShell (cleanup-report-flows-2026-08-24 P-001, D-001) — the SHARED
 * grouped report-review surface consumed by BOTH the plan-cleanup review
 * (P-007) and the inbox bulk-resolve review (P-008). Owner-picked mockup
 * Option B: review-at-volume beats review-in-place — findings grouped by fix
 * kind with per-group tri-state selection, an evidence column, per-row
 * confidence flags, and ONE Apply-selected.
 *
 * Presentational and data-source-agnostic on purpose: consumers map their own
 * findings (scanner candidates / inbox recommendations) into groups and wire
 * apply/dismiss to their own run store. The takeover chrome + nuqs param
 * helper live in ReportTakeover.tsx (the PLAN_DASHBOARD_PARAM pattern);
 * per-flow params (`?opcln=` …) belong to the consumers — one key per
 * renderer, same as pdash/pplan/wppop.
 *
 * Selection is deliberately useState, not nuqs: a checkbox set mid-review is
 * an unsent draft (the nuqs guide's mid-edit-draft case), and serializing
 * hundreds of row ids into the URL is the exact anti-pattern the guide bans.
 * The takeover OPEN state — the user-meaningful bit — IS in the URL, owned by
 * the consumer's param.
 *
 * Mount it keyed by the RUN (`<ReviewReportShell key={runId} …>`, the
 * PlanDashboard `key={planSlug}` pattern) so a fresh run resets selection and
 * collapse state; within one run, rows flipping pending→applied are handled
 * live (selection self-intersects with what is still pending).
 */
import { useMemo, useState, type ReactNode } from 'react';
import './review-report.css';

export type ReviewRowConfidence = 'provable' | 'recommended';
export type ReviewRowStatus = 'pending' | 'applied' | 'dismissed';

export interface ReviewReportRow {
  /** Stable row id (e.g. the scanner's findingId) — the unit Apply targets. */
  id: string;
  title: string;
  /** Evidence lines rendered in the evidence column (already human-readable). */
  evidence: string[];
  confidence: ReviewRowConfidence;
  /** 'applied' rows render as already-done (auto-applied with evidence
   *  recorded) and are never selectable; default 'pending'. */
  status?: ReviewRowStatus;
  /** Optional drill-in content (P-008 keeps its inline per-row recommendation
   *  cards intact as exactly this). */
  detail?: ReactNode;
}

export interface ReviewReportGroup {
  id: string;
  title: string;
  description?: string;
  rows: ReviewReportRow[];
}

export interface ReviewReportShellProps {
  title: string;
  subtitle?: ReactNode;
  groups: ReviewReportGroup[];
  /** Initial selection: 'pending' (default — every selectable row), 'none', or
   *  an explicit row-id list. */
  defaultSelected?: 'pending' | 'none' | readonly string[];
  applyLabel?: string;
  dismissLabel?: string;
  /** Disables all interaction while an apply is in flight. */
  busy?: boolean;
  onApply: (selectedRowIds: string[]) => void;
  onDismiss: () => void;
}

function rowStatus(row: ReviewReportRow): ReviewRowStatus {
  return row.status ?? 'pending';
}

function initialSelection(
  groups: readonly ReviewReportGroup[],
  defaultSelected: ReviewReportShellProps['defaultSelected'],
): Set<string> {
  if (defaultSelected === 'none') return new Set();
  if (Array.isArray(defaultSelected)) return new Set(defaultSelected);
  const all = new Set<string>();
  for (const g of groups) for (const r of g.rows) if (rowStatus(r) === 'pending') all.add(r.id);
  return all;
}

const CONFIDENCE_LABEL: Record<ReviewRowConfidence, string> = {
  provable: 'provable',
  recommended: 'recommended',
};

export default function ReviewReportShell({
  title,
  subtitle,
  groups,
  defaultSelected = 'pending',
  applyLabel = 'Apply selected',
  dismissLabel = 'Dismiss',
  busy = false,
  onApply,
  onDismiss,
}: ReviewReportShellProps) {
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(groups, defaultSelected));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const pendingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of groups) for (const r of g.rows) if (rowStatus(r) === 'pending') ids.add(r.id);
    return ids;
  }, [groups]);

  // Selection intersected with what is STILL pending — a consumer marking rows
  // applied between renders must not leave phantom selections behind.
  const liveSelected = useMemo(() => {
    const s = new Set<string>();
    for (const id of selected) if (pendingIds.has(id)) s.add(id);
    return s;
  }, [selected, pendingIds]);

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (group: ReviewReportGroup) => {
    const ids = group.rows.filter((r) => rowStatus(r) === 'pending').map((r) => r.id);
    const allOn = ids.length > 0 && ids.every((id) => liveSelected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleCollapsed = (groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  return (
    <section className="review-report" data-testid="review-report">
      <header className="review-report__head">
        <div className="review-report__head-text">
          <h2 className="review-report__title">{title}</h2>
          {subtitle != null && <div className="review-report__subtitle">{subtitle}</div>}
        </div>
        <div className="review-report__actions">
          <button
            type="button"
            className="review-report__apply"
            data-testid="review-report-apply"
            disabled={busy || liveSelected.size === 0}
            onClick={() => onApply([...liveSelected].sort())}
          >
            {applyLabel} ({liveSelected.size})
          </button>
          <button
            type="button"
            className="review-report__dismiss"
            data-testid="review-report-dismiss"
            disabled={busy}
            onClick={onDismiss}
          >
            {dismissLabel}
          </button>
        </div>
      </header>

      {groups.map((group) => {
        const groupPending = group.rows.filter((r) => rowStatus(r) === 'pending');
        const selCount = groupPending.filter((r) => liveSelected.has(r.id)).length;
        const groupState: 'none' | 'some' | 'all' =
          groupPending.length === 0 || selCount === 0 ? 'none' : selCount === groupPending.length ? 'all' : 'some';
        const isCollapsed = collapsed.has(group.id);
        return (
          <section key={group.id} className="review-report__group" data-testid={`review-group-${group.id}`}>
            <header className="review-report__group-head">
              <input
                type="checkbox"
                className="review-report__group-check"
                data-testid={`review-group-check-${group.id}`}
                aria-label={`Select all in ${group.title}`}
                checked={groupState === 'all'}
                ref={(el) => {
                  if (el) el.indeterminate = groupState === 'some';
                }}
                disabled={busy || groupPending.length === 0}
                onChange={() => toggleGroup(group)}
              />
              <button
                type="button"
                className="review-report__group-toggle"
                data-testid={`review-group-toggle-${group.id}`}
                aria-expanded={!isCollapsed}
                onClick={() => toggleCollapsed(group.id)}
              >
                <span className={`review-report__chevron${isCollapsed ? ' review-report__chevron--closed' : ''}`} aria-hidden>
                  ▾
                </span>
                <span className="review-report__group-title">{group.title}</span>
                <span className="review-report__group-count">
                  {selCount}/{groupPending.length} selected · {group.rows.length} finding{group.rows.length === 1 ? '' : 's'}
                </span>
              </button>
            </header>
            {group.description != null && !isCollapsed && (
              <p className="review-report__group-desc">{group.description}</p>
            )}
            {!isCollapsed && (
              <ul className="review-report__rows">
                {group.rows.map((row) => {
                  const status = rowStatus(row);
                  const selectable = status === 'pending';
                  return (
                    <li
                      key={row.id}
                      className={`review-report__row review-report__row--${status}`}
                      data-testid={`review-row-${row.id}`}
                    >
                      <span className="review-report__row-check-slot">
                        {selectable ? (
                          <input
                            type="checkbox"
                            data-testid={`review-row-check-${row.id}`}
                            aria-label={`Select ${row.title}`}
                            checked={liveSelected.has(row.id)}
                            disabled={busy}
                            onChange={() => toggleRow(row.id)}
                          />
                        ) : (
                          <span
                            className="review-report__row-status-mark"
                            data-testid={`review-row-mark-${row.id}`}
                            title={status}
                            aria-hidden
                          >
                            {status === 'applied' ? '✓' : '—'}
                          </span>
                        )}
                      </span>
                      <span className="review-report__row-main">
                        <span className="review-report__row-title">{row.title}</span>
                        {row.detail != null && <span className="review-report__row-detail">{row.detail}</span>}
                      </span>
                      <span className="review-report__row-evidence">
                        {row.evidence.map((line, i) => (
                          <span key={i} className="review-report__evidence-item">
                            {line}
                          </span>
                        ))}
                      </span>
                      <span
                        className={`review-report__row-conf review-report__row-conf--${row.confidence}`}
                        data-testid={`review-row-conf-${row.id}`}
                      >
                        {CONFIDENCE_LABEL[row.confidence]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}
