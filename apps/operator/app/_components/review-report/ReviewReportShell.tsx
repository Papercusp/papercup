"use client";

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
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { Button } from "../../harness/Button";
import { Checkbox } from "../../harness/Checkbox";
import "./review-report.css";

export type ReviewRowConfidence = "provable" | "recommended";
export type ReviewRowStatus = "pending" | "applied" | "dismissed";

export interface ReviewReportTransition {
  from: string;
  to: string;
}

export interface ReviewReportRow {
  /** Stable row id (e.g. the scanner's findingId) — the unit Apply targets. */
  id: string;
  title: string;
  /** Compact Option-B identity cells. Plans use plan slug + P-NNN/plan;
   *  Inbox uses source kind + recommended action. */
  sourceLabel?: string;
  referenceLabel?: string;
  /** Structured before → after state change. Omitted for action-oriented rows. */
  transition?: ReviewReportTransition;
  /** Evidence lines rendered in the evidence column (already human-readable). */
  evidence: string[];
  confidence: ReviewRowConfidence;
  /** 'applied' rows render as already-done (auto-applied with evidence
   *  recorded) and are never selectable; default 'pending'. */
  status?: ReviewRowStatus;
  /** A pending row whose action still needs authored/manual input remains
   *  visible but cannot enter Apply-selected. Default true for pending rows. */
  selectable?: boolean;
  /** Optional drill-in content (P-008 keeps its inline per-row recommendation
   *  cards intact as exactly this). */
  detail?: ReactNode;
  /** Dynamic apply failure. Kept separate from detail so a flow-specific
   *  drill-in can remain mounted while the failure is visibly announced. */
  error?: string;
}

export interface ReviewReportGroup {
  id: string;
  title: string;
  description?: string;
  rows: ReviewReportRow[];
}

export interface ReviewReportShellProps {
  title: string;
  /** Flow-specific symbol inside the shared Option-B title tile. */
  icon?: ReactNode;
  subtitle?: ReactNode;
  groups: ReviewReportGroup[];
  /** Initial selection: 'pending' (default — every selectable row), 'none', or
   *  an explicit row-id list. */
  defaultSelected?: "pending" | "none" | readonly string[];
  applyLabel?: string;
  dismissLabel?: string;
  /** Disables all interaction while an apply is in flight. */
  busy?: boolean;
  /** Flow-specific guarantee / caveat below the grouped findings. */
  footer?: ReactNode;
  onApply: (selectedRowIds: string[]) => void;
  onDismiss: () => void;
}

function rowStatus(row: ReviewReportRow): ReviewRowStatus {
  return row.status ?? "pending";
}

function rowSelectable(row: ReviewReportRow): boolean {
  return rowStatus(row) === "pending" && row.selectable !== false;
}

function initialSelection(
  groups: readonly ReviewReportGroup[],
  defaultSelected: ReviewReportShellProps["defaultSelected"],
): Set<string> {
  if (defaultSelected === "none") return new Set();
  if (Array.isArray(defaultSelected)) return new Set(defaultSelected);
  const all = new Set<string>();
  for (const g of groups)
    for (const r of g.rows) if (rowSelectable(r)) all.add(r.id);
  return all;
}

const CONFIDENCE_LABEL: Record<ReviewRowConfidence, string> = {
  provable: "provable",
  recommended: "recommended",
};

export default function ReviewReportShell({
  title,
  icon,
  subtitle,
  groups,
  defaultSelected = "pending",
  applyLabel = "Apply selected",
  dismissLabel = "Dismiss",
  busy = false,
  footer,
  onApply,
  onDismiss,
}: ReviewReportShellProps) {
  const titleId = useId();
  const [selected, setSelected] = useState<Set<string>>(() =>
    initialSelection(groups, defaultSelected),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedReasons, setExpandedReasons] = useState<Set<string>>(
    () => new Set(),
  );
  const reportRef = useRef<HTMLElement>(null);
  const applyButtonRef = useRef<HTMLButtonElement>(null);
  const dismissButtonRef = useRef<HTMLButtonElement>(null);
  const rowNodes = useRef(new Map<string, HTMLLIElement>());
  const groupToggleNodes = useRef(new Map<string, HTMLButtonElement>());
  const focusedGroupContent = useRef<{
    element: HTMLElement;
    rowId: string | null;
    groupId: string;
  } | null>(null);
  const focusedHeaderAction = useRef<{
    element: HTMLButtonElement;
    action: "apply" | "dismiss";
  } | null>(null);
  const restoreActionFocusAfterBusy = useRef<"apply" | "dismiss" | null>(null);
  const wasBusy = useRef(busy);

  const pendingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of groups)
      for (const r of g.rows) if (rowSelectable(r)) ids.add(r.id);
    return ids;
  }, [groups]);

  const presentRowIds = useMemo(
    () => new Set(groups.flatMap((group) => group.rows.map((row) => row.id))),
    [groups],
  );

  const reportCounts = useMemo(() => {
    let total = 0;
    let applied = 0;
    let manual = 0;
    for (const group of groups) {
      for (const row of group.rows) {
        total += 1;
        if (rowStatus(row) === "applied") applied += 1;
        else if (rowStatus(row) === "pending" && !rowSelectable(row)) manual += 1;
      }
    }
    return { total, applied, manual };
  }, [groups]);

  // A live report can remove a row and later reintroduce the same stable id.
  // Once it left the current report, a stale expanded state must not resurrect
  // without a fresh owner action.
  useLayoutEffect(() => {
    setExpandedReasons((previous) => {
      if ([...previous].every((id) => presentRowIds.has(id))) return previous;
      return new Set([...previous].filter((id) => presentRowIds.has(id)));
    });
  }, [presentRowIds]);

  // Selection intersected with what is STILL pending — a consumer marking rows
  // applied between renders must not leave phantom selections behind.
  const liveSelected = useMemo(() => {
    const s = new Set<string>();
    for (const id of selected) if (pendingIds.has(id)) s.add(id);
    return s;
  }, [selected, pendingIds]);

  useLayoutEffect(() => {
    const actionSettled = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (actionSettled) {
      const erroredGroupIds = new Set(
        groups
          .filter((group) => group.rows.some((row) => row.error != null))
          .map((group) => group.id),
      );
      if (erroredGroupIds.size > 0) {
        setCollapsed((previous) => {
          if (![...erroredGroupIds].some((id) => previous.has(id))) {
            return previous;
          }
          const next = new Set(previous);
          for (const id of erroredGroupIds) next.delete(id);
          return next;
        });
      }
    }

    const action = restoreActionFocusAfterBusy.current;
    if (!actionSettled || action === null) return;

    restoreActionFocusAfterBusy.current = null;
    const target =
      action === "dismiss" || liveSelected.size === 0
        ? dismissButtonRef.current
        : applyButtonRef.current;
    target?.focus({ preventScroll: true });
  }, [busy, groups, liveSelected.size]);

  useLayoutEffect(() => {
    const previous = focusedHeaderAction.current;
    const previousFocusUnavailable =
      previous !== null &&
      (!previous.element.isConnected || previous.element.matches(":disabled"));
    if (
      previous === null ||
      !previousFocusUnavailable ||
      document.activeElement !== document.body
    ) {
      return;
    }

    // A passive busy transition can disable both actions before either is a
    // valid landing point. Reuse the settlement path once they become usable.
    if (busy) {
      restoreActionFocusAfterBusy.current ??= previous.action;
      return;
    }

    const preferred =
      previous.action === "apply"
        ? applyButtonRef.current
        : dismissButtonRef.current;
    const dismiss = dismissButtonRef.current;
    const apply = applyButtonRef.current;
    const target =
      preferred && !preferred.disabled
        ? preferred
        : dismiss && !dismiss.disabled
          ? dismiss
          : apply && !apply.disabled
            ? apply
            : reportRef.current;

    focusedHeaderAction.current = null;
    target?.focus({ preventScroll: true });
  }, [busy, groups, liveSelected.size]);

  useLayoutEffect(() => {
    const previous = focusedGroupContent.current;
    const previousFocusUnavailable =
      previous !== null &&
      (!previous.element.isConnected || previous.element.matches(":disabled"));
    if (
      previous === null ||
      !previousFocusUnavailable ||
      document.activeElement !== document.body
    ) {
      return;
    }

    const row = previous.rowId
      ? rowNodes.current.get(previous.rowId)
      : undefined;
    const group = groupToggleNodes.current.get(previous.groupId);
    const dismiss = dismissButtonRef.current;
    const target =
      row ??
      group ??
      (dismiss && !dismiss.disabled ? dismiss : reportRef.current);

    // Clear before focusing: the capture handler records the new surviving
    // context, which must not be overwritten after focus() returns.
    focusedGroupContent.current = null;
    target?.focus({ preventScroll: true });
  }, [groups]);

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (group: ReviewReportGroup) => {
    const ids = group.rows.filter(rowSelectable).map((r) => r.id);
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

  const toggleReason = (rowId: string) => {
    setExpandedReasons((previous) => {
      const next = new Set(previous);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const selectionStatus = busy
    ? "Updating report. Please wait."
    : `${liveSelected.size} of ${pendingIds.size} selectable recommendation${pendingIds.size === 1 ? "" : "s"} selected.`;

  return (
    <section
      ref={reportRef}
      className="review-report"
      data-testid="review-report"
      aria-busy={busy || undefined}
      aria-labelledby={titleId}
      tabIndex={-1}
      onFocusCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const action =
          target === applyButtonRef.current
            ? "apply"
            : target === dismissButtonRef.current
              ? "dismiss"
              : null;
        focusedHeaderAction.current =
          action !== null && target instanceof HTMLButtonElement
            ? { element: target, action }
            : null;
        const group = target.closest<HTMLElement>("[data-review-group-id]");
        if (!group?.dataset.reviewGroupId) {
          focusedGroupContent.current = null;
          return;
        }
        const row = target.closest<HTMLElement>("[data-review-row-id]");
        focusedGroupContent.current = {
          element: target,
          rowId: row?.dataset.reviewRowId ?? null,
          groupId: group.dataset.reviewGroupId,
        };
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && reportRef.current?.contains(next)) return;
        // Removing a focused subtree or disabling its focused native control
        // emits focusout with no related target in Chromium. Preserve that
        // context for the layout-effect fallback, but forget it when focus
        // deliberately moves to a concrete outside node.
        if (next !== null) {
          focusedGroupContent.current = null;
          focusedHeaderAction.current = null;
        }
      }}
    >
      <header className="review-report__head">
        <div className="review-report__identity">
          {icon != null ? (
            <span
              className="review-report__icon"
              data-testid="review-report-icon"
              aria-hidden="true"
            >
              {icon}
            </span>
          ) : null}
          <div className="review-report__head-text">
            <span className="review-report__eyebrow">Resolution review</span>
            <h2 id={titleId} className="review-report__title">
              {title}
            </h2>
            {subtitle != null && (
              <div className="review-report__subtitle">{subtitle}</div>
            )}
          </div>
        </div>
        <div className="review-report__actions">
          <Button
            ref={applyButtonRef}
            variant="primary"
            size="lg"
            className="review-report__apply"
            data-testid="review-report-apply"
            disabled={busy || liveSelected.size === 0}
            onClick={(event) => {
              restoreActionFocusAfterBusy.current =
                document.activeElement === event.currentTarget ? "apply" : null;
              onApply([...liveSelected].sort());
            }}
          >
            <Check size={14} aria-hidden="true" />
            {applyLabel} ({liveSelected.size})
          </Button>
          <Button
            ref={dismissButtonRef}
            size="lg"
            className="review-report__dismiss"
            data-testid="review-report-dismiss"
            disabled={busy}
            onClick={(event) => {
              restoreActionFocusAfterBusy.current =
                document.activeElement === event.currentTarget
                  ? "dismiss"
                  : null;
              onDismiss();
            }}
          >
            {dismissLabel}
          </Button>
        </div>
      </header>

      <div
        className="review-report__summary"
        data-testid="review-report-summary"
        aria-label="Report summary"
      >
        <div className="review-report__summary-lead">
          <span className="review-report__summary-kicker">Current selection</span>
          <strong data-testid="review-report-selected-count">
            {liveSelected.size}
          </strong>
          <span>
            of {pendingIds.size} ready to apply
          </span>
        </div>
        <dl className="review-report__metrics">
          <div className="review-report__metric">
            <dt>Results</dt>
            <dd>{reportCounts.total}</dd>
          </div>
          <div className="review-report__metric review-report__metric--good">
            <dt>Handled</dt>
            <dd>{reportCounts.applied}</dd>
          </div>
          <div className="review-report__metric review-report__metric--manual">
            <dt>Manual</dt>
            <dd>{reportCounts.manual}</dd>
          </div>
        </dl>
      </div>

      <span
        className="pc-sr-only"
        data-testid="review-report-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {selectionStatus}
      </span>

      <div className="review-report__groups">
        {groups.map((group, index) => {
          const groupPending = group.rows.filter(rowSelectable);
          const selCount = groupPending.filter((r) =>
            liveSelected.has(r.id),
          ).length;
          const groupState: "none" | "some" | "all" =
            groupPending.length === 0 || selCount === 0
              ? "none"
              : selCount === groupPending.length
                ? "all"
                : "some";
          const isCollapsed = collapsed.has(group.id);
          return (
            <section
              key={group.id}
              id={`review-report-group-${index}`}
              className="review-report__group"
              data-testid={`review-group-${group.id}`}
              data-review-group-id={group.id}
            >
              <header className="review-report__group-head">
                <Checkbox
                  dataTestId={`review-group-check-${group.id}`}
                  ariaLabel={`Select all in ${group.title}`}
                  checked={groupState === "all"}
                  indeterminate={groupState === "some"}
                  disabled={busy || groupPending.length === 0}
                  onChange={() => toggleGroup(group)}
                />
                <button
                  ref={(node) => {
                    if (node) groupToggleNodes.current.set(group.id, node);
                    else groupToggleNodes.current.delete(group.id);
                  }}
                  type="button"
                  className="review-report__group-toggle"
                  data-testid={`review-group-toggle-${group.id}`}
                  aria-expanded={!isCollapsed}
                  disabled={busy}
                  onClick={() => toggleCollapsed(group.id)}
                >
                  <span className="review-report__group-toggle-inner">
                    <span className="review-report__group-title">
                      {group.title}
                    </span>
                    <span
                      className="review-report__group-count"
                      data-testid={`review-group-count-${group.id}`}
                    >
                      {group.rows.length}
                    </span>
                    <span
                      className={`review-report__group-selection review-report__group-selection--${groupState}`}
                      data-testid={`review-group-selection-${group.id}`}
                    >
                      {groupPending.length > 0
                        ? `${selCount}/${groupPending.length} selected`
                        : "Review only"}
                    </span>
                    {group.description != null ? (
                      <span className="review-report__group-desc">
                        {group.description}
                      </span>
                    ) : null}
                    <ChevronDown
                      size={14}
                      className={`review-report__chevron${isCollapsed ? " review-report__chevron--closed" : ""}`}
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </header>
              {!isCollapsed && (
                <ul className="review-report__rows">
                  {group.rows.map((row, rowIndex) => {
                    const status = rowStatus(row);
                    const selectable = rowSelectable(row);
                    const reasonOpen = expandedReasons.has(row.id);
                    const evidence =
                      row.evidence.length > 0
                        ? row.evidence
                        : ["No reason was recorded."];
                    const reasonRegionId = `${titleId}-reason-${index}-${rowIndex}`;
                    return (
                      <li
                        ref={(node) => {
                          if (node) rowNodes.current.set(row.id, node);
                          else rowNodes.current.delete(row.id);
                        }}
                        key={row.id}
                        className={`review-report__row review-report__row--${status}`}
                        data-testid={`review-row-${row.id}`}
                        data-review-row-id={row.id}
                        tabIndex={-1}
                      >
                        <span className="review-report__row-check-slot">
                          {selectable ? (
                            <Checkbox
                              dataTestId={`review-row-check-${row.id}`}
                              ariaLabel={`Select ${row.title}`}
                              checked={liveSelected.has(row.id)}
                              disabled={busy}
                              onChange={() => toggleRow(row.id)}
                            />
                          ) : (
                            <span
                              className="review-report__row-status-mark"
                              data-testid={`review-row-mark-${row.id}`}
                              title={
                                status === "pending"
                                  ? "manual review required"
                                  : status
                              }
                              aria-hidden
                            >
                              {status === "applied"
                                ? "✓"
                                : status === "pending"
                                  ? "↗"
                                  : "—"}
                            </span>
                          )}
                        </span>
                        <span className="review-report__row-identity">
                          {row.sourceLabel != null ? (
                            <span className="review-report__source-chip">
                              {row.sourceLabel}
                            </span>
                          ) : null}
                          {row.referenceLabel != null ? (
                            <span className="review-report__reference">
                              {row.referenceLabel}
                            </span>
                          ) : null}
                        </span>
                        <span className="review-report__row-change">
                          {row.transition != null ? (
                            <span
                              className="review-report__transition"
                              data-testid={`review-row-transition-${row.id}`}
                            >
                              <span
                                className="review-report__state review-report__state--from"
                                data-state={row.transition.from}
                              >
                                {row.transition.from}
                              </span>
                              <span
                                className="review-report__transition-arrow"
                                aria-hidden="true"
                              >
                                →
                              </span>
                              <span
                                className="review-report__state review-report__state--to"
                                data-state={row.transition.to}
                              >
                                {row.transition.to}
                              </span>
                            </span>
                          ) : (
                            <span className="review-report__row-title">
                              {row.title}
                            </span>
                          )}
                        </span>
                        <span className="review-report__row-evidence">
                          <button
                            type="button"
                            className="review-report__reason-toggle"
                            data-testid={`review-row-reason-${row.id}`}
                            aria-label={`Why ${row.title}`}
                            aria-expanded={reasonOpen}
                            aria-controls={reasonRegionId}
                            disabled={busy}
                            onClick={() => toggleReason(row.id)}
                          >
                            <span className="review-report__reason-toggle-inner">
                              <span className="review-report__reason-label">
                                Why
                              </span>
                              <span className="review-report__evidence-item">
                                {evidence[0]}
                              </span>
                              <ChevronDown
                                size={12}
                                className={`review-report__reason-chevron${reasonOpen ? " review-report__reason-chevron--open" : ""}`}
                                aria-hidden="true"
                              />
                            </span>
                          </button>
                        </span>
                        <span
                          className={`review-report__row-conf review-report__row-conf--${row.confidence}`}
                          data-testid={`review-row-conf-${row.id}`}
                        >
                          {CONFIDENCE_LABEL[row.confidence]}
                        </span>
                        {reasonOpen ? (
                          <div
                            id={reasonRegionId}
                            className="review-report__reason-detail"
                            data-testid={`review-row-reason-detail-${row.id}`}
                            role="region"
                            aria-label={`Why ${row.title}`}
                          >
                            <strong>Why this decision</strong>
                            <ul>
                              {evidence.map((line, evidenceIndex) => (
                                <li key={`${row.id}-evidence-${evidenceIndex}`}>
                                  {line}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {row.detail != null ? (
                          <span className="review-report__row-detail">
                            {row.detail}
                          </span>
                        ) : null}
                        {row.error != null ? (
                          <span
                            className="review-report__row-error"
                            data-testid={`review-row-error-${row.id}`}
                            role="alert"
                            aria-atomic="true"
                          >
                            {row.error}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {footer != null ? (
        <footer className="review-report__footer">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>{footer}</span>
        </footer>
      ) : null}
    </section>
  );
}
