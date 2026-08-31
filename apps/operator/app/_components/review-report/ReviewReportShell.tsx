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
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { BulkConfidence } from "@papercusp/operator-core/lib/attention/bulk-dispositions";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { Button } from "../../harness/Button";
import { Checkbox } from "../../harness/Checkbox";
import { Tooltip } from "../../harness/Tooltip";
import "./review-report.css";

/** Keep the report's owner-facing confidence vocabulary pinned to the
 * resolver contract instead of collapsing it into presentation-only aliases. */
export type ReviewRowConfidence = BulkConfidence;
export type ReviewRowStatus = "pending" | "applied" | "dismissed";
export type ReviewRowAccounting =
  | "ready"
  | "handled"
  | "manual"
  | "not-assessed"
  | "not-applied";

export interface ReviewReportTransition {
  from: string;
  to: string;
}

/** Visual weight for a row's action verb. Semantic only — never the sole
 *  carrier of meaning, because the label always states the action in words. */
export type ReviewRowActionTone =
  | "apply"
  | "good"
  | "warn"
  | "danger"
  | "manual";

/**
 * The verb naming what happens to this row (D-001).
 *
 * The group header already describes the fix KIND, but a sticky header scrolls
 * out of a long group, so a row twelve deep was a checkbox with no stated
 * consequence. Every row therefore carries its own verb, in the same vocabulary
 * as the button that commits it.
 */
export interface ReviewRowAction {
  /** Imperative and short: "Clear blocker", "Archive plan", "You write it". */
  label: string;
  tone?: ReviewRowActionTone;
  /** Presentational glyph. The label alone must still read correctly. */
  icon?: ReactNode;
  /** Fuller phrasing for the row's accessible description, when "Clear
   *  blocker" alone would not tell a screen-reader user what Apply does. */
  description?: string;
}

/**
 * One entry in a row's overflow menu (P-008).
 *
 * These are the per-ROW recoveries — Retry, Dismiss, Reconcile, Apply just
 * this one — as opposed to the batch Apply in the header or the run-level
 * intents in the bar. Inbox already had them, buried inside a drill-in that
 * only opens for `pending` rows with a hydrated snapshot; Plans had none at
 * all. Hoisting them to the row is what makes the two flows symmetric (R8).
 *
 * A disabled entry is RENDERED, not hidden, and must say why: a recovery that
 * silently vanishes is indistinguishable from one that never existed.
 */
export interface ReviewRowMenuAction {
  id: string;
  label: string;
  tone?: "default" | "danger";
  disabled?: boolean;
  /** Required when `disabled` — a greyed control still owes an explanation. */
  disabledReason?: string;
  run: () => void;
}

export interface ReviewReportRow {
  /** Stable row id (e.g. the scanner's findingId) — the unit Apply targets. */
  id: string;
  title: string;
  /** The verb this row commits. Omitted only by a row whose title already IS
   *  the action (legacy callers); prefer supplying it. */
  action?: ReviewRowAction;
  /** Compact Option-B identity cells. Plans use plan slug + P-NNN/plan;
   *  Inbox uses source kind + recommended action. */
  sourceLabel?: string;
  referenceLabel?: string;
  /** Makes the source chip a REAL control that opens the row's subject.
   *  Without it the chip renders unstyled-as-a-link, because a chip that looks
   *  clickable and is inert is the affordance bug this replaced (D-001). */
  onOpenSource?: () => void;
  /** Accessible name for that control; defaults to "Open <sourceLabel>". */
  openSourceLabel?: string;
  /** Structured before → after state change. Omitted for action-oriented rows. */
  transition?: ReviewReportTransition;
  /** Evidence lines rendered in the evidence column (already human-readable). */
  evidence: string[];
  confidence: ReviewRowConfidence;
  /** Exhaustive owner-facing result category. Required instead of inferred:
   *  selection/status cannot distinguish a drafted answer (Manual) from a
   *  ready bulk action, or an unresolved skipped row (Not applied) from other
   *  pending work. */
  accounting: ReviewRowAccounting;
  /** 'applied' rows render as already-done (auto-applied with evidence
   *  recorded) and are never selectable; default 'pending'. */
  status?: ReviewRowStatus;
  /** A pending row whose action still needs authored/manual input remains
   *  visible but cannot enter Apply-selected. Default true for pending rows. */
  selectable?: boolean;
  /** Per-row recoveries, in an overflow menu beside the disclosure (P-008).
   *  Empty/omitted renders no menu button at all. */
  actions?: ReviewRowMenuAction[];
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
  /** Start groups with no selectable actions behind their existing disclosure.
   *  The exhaustive summary still accounts for every row, and the owner can
   *  expand the group on demand. Off by default for existing report flows. */
  collapseNonSelectableByDefault?: boolean;
  applyLabel?: string;
  dismissLabel?: string;
  /** The run's own state and controls (RunLifecycleBar), directly under the
   *  header. Owned by the consumer because only it can service the intents,
   *  but rendered here so both flows place it identically. */
  runBar?: ReactNode;
  /**
   * Imperative "show me those rows" request, servicing the run bar's `reveal`
   * intent (D-001: a control that names rows must actually go to them). The
   * shell expands the named group, scrolls it into view and focuses its toggle.
   * `seq` must change on every request so repeat clicks re-trigger — a bare
   * group id cannot, since the second click carries the identical value.
   */
  revealRequest?: { groupId: string; seq: number } | null;
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

function nonSelectableStatusLabel(status: ReviewRowStatus): string {
  if (status === "applied") return "Applied";
  if (status === "dismissed") return "Dismissed";
  return "Manual review required";
}

function rowSelectable(row: ReviewReportRow): boolean {
  return rowStatus(row) === "pending" && row.selectable !== false;
}

export interface ReviewReportPartition {
  results: number;
  ready: number;
  handled: number;
  manual: number;
  /** Found by the scan but never judged — a stopped or died run, not owner
   *  work. Kept apart from `manual` because the two need opposite actions:
   *  manual wants a human, not-assessed wants a resume. */
  notAssessed: number;
  notApplied: number;
}

/** D-003: every rendered row belongs to exactly one owner-facing outcome.
 * Keep this projection shared so Inbox and Plan reports cannot drift into
 * flow-specific count semantics. */
export function partitionReviewRows(
  groups: readonly ReviewReportGroup[],
): ReviewReportPartition {
  let results = 0;
  let ready = 0;
  let handled = 0;
  let manual = 0;
  let notAssessed = 0;
  let notApplied = 0;

  for (const group of groups) {
    for (const row of group.rows) {
      results += 1;
      switch (row.accounting) {
        case "ready":
          ready += 1;
          break;
        case "handled":
          handled += 1;
          break;
        case "manual":
          manual += 1;
          break;
        case "not-assessed":
          notAssessed += 1;
          break;
        case "not-applied":
          notApplied += 1;
          break;
        default: {
          const unsupportedAccounting: never = row.accounting;
          throw new Error(
            `Unsupported ReviewReport accounting category: ${String(unsupportedAccounting)}`,
          );
        }
      }
    }
  }

  const accounted = ready + handled + manual + notAssessed + notApplied;
  if (results !== accounted) {
    throw new Error(
      `ReviewReport accounting invariant failed: ${results} results != ${accounted} partitioned rows`,
    );
  }

  return { results, ready, handled, manual, notAssessed, notApplied };
}

/**
 * Owner-facing tile vocabulary (P-004).
 *
 * `RESULTS / READY / HANDLED / MANUAL / NOT APPLIED` is the resolver's own
 * vocabulary. These labels say what the owner has to DO instead, and the count
 * that answers "how much is left for me" leads.
 */
export const REVIEW_PARTITION_TILES: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  read: (partition: ReviewReportPartition) => number;
}> = [
  {
    id: "ready",
    label: "Papercup can fix",
    hint: "Selected below. Apply commits exactly these.",
    read: (p) => p.ready,
  },
  {
    id: "manual",
    label: "Needs you",
    hint: "No safe automatic action — each says what to do and where.",
    read: (p) => p.manual,
  },
  {
    id: "handled",
    label: "Already fixed",
    hint: "Applied, with the evidence recorded.",
    read: (p) => p.handled,
  },
  {
    id: "not-applied",
    label: "Skipped",
    hint: "Dismissed or deliberately left alone.",
    read: (p) => p.notApplied,
  },
  {
    id: "not-assessed",
    label: "Not assessed",
    hint: "Found by the scan but never judged — the run stopped first.",
    read: (p) => p.notAssessed,
  },
];

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
  high: "high",
  medium: "medium",
  low: "low",
  insufficient: "insufficient",
};

/**
 * Row-scoped explicit-disclosure store for the report's hottest interaction
 * path.
 *
 * A parent `useState(activeRowId)` makes every click reconcile the complete
 * report. Real runs can contain hundreds of rows, so activation stays outside
 * the shell render and subscribers are indexed by row id. A change notifies
 * only the previous and next rows; every untouched row stays out of React's
 * render and commit work.
 */
class ReviewDetailController {
  private activeRowId: string | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  subscribe(rowId: string, listener: () => void): () => void {
    const rowListeners = this.listeners.get(rowId) ?? new Set<() => void>();
    rowListeners.add(listener);
    this.listeners.set(rowId, rowListeners);
    return () => {
      rowListeners.delete(listener);
      if (rowListeners.size === 0) this.listeners.delete(rowId);
    };
  }

  isActive(rowId: string): boolean {
    return this.activeRowId === rowId;
  }

  toggle(rowId: string): void {
    this.activate(this.activeRowId === rowId ? null : rowId);
  }

  clear(): void {
    this.activate(null);
  }

  dispose(): void {
    this.activeRowId = null;
    this.listeners.clear();
  }

  prune(presentRowIds: ReadonlySet<string>): void {
    if (this.activeRowId !== null && !presentRowIds.has(this.activeRowId)) {
      this.activate(null);
    }
  }

  private activate(nextRowId: string | null): void {
    const previousRowId = this.activeRowId;
    if (previousRowId === nextRowId) return;
    this.activeRowId = nextRowId;
    if (previousRowId !== null) this.emit(previousRowId);
    if (nextRowId !== null) this.emit(nextRowId);
  }

  private emit(rowId: string): void {
    for (const listener of this.listeners.get(rowId) ?? []) listener();
  }
}

function clickBelongsToNestedControl(
  target: EventTarget | null,
  row: HTMLLIElement,
): boolean {
  if (!(target instanceof Element)) return false;
  const nested = target.closest(
    "button, a, input, textarea, select, [role='button'], [role='link'], [data-review-detail-region]",
  );
  return nested !== null && row.contains(nested);
}

interface ReviewReportRowViewProps {
  row: ReviewReportRow;
  detailRegionId: string;
  selected: boolean;
  busy: boolean;
  detailController: ReviewDetailController;
  registerRowNode: (rowId: string, node: HTMLLIElement | null) => void;
  onToggleRow: (rowId: string) => void;
}

const ReviewReportRowView = memo(function ReviewReportRowView({
  row,
  detailRegionId,
  selected,
  busy,
  detailController,
  registerRowNode,
  onToggleRow,
}: ReviewReportRowViewProps) {
  const subscribe = useCallback(
    (listener: () => void) => detailController.subscribe(row.id, listener),
    [detailController, row.id],
  );
  const getSnapshot = useCallback(
    () => detailController.isActive(row.id),
    [detailController, row.id],
  );
  const detailOpen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setRowNode = useCallback(
    (node: HTMLLIElement | null) => registerRowNode(row.id, node),
    [registerRowNode, row.id],
  );
  const status = rowStatus(row);
  const selectable = rowSelectable(row);
  const evidence =
    row.evidence.length > 0 ? row.evidence : ["No reason was recorded."];
  const confidenceLabel = CONFIDENCE_LABEL[row.confidence];
  const detailAction = `${detailOpen ? "Hide" : "Show"} why: ${row.title} — ${confidenceLabel} confidence`;
  const action = row.action;
  const openSource = row.onOpenSource;

  return (
    <li
      ref={setRowNode}
      className={`review-report__row review-report__row--${status}${detailOpen ? " review-report__row--detail-open" : ""}${busy ? " review-report__row--busy" : ""}`}
      data-testid={`review-row-${row.id}`}
      data-review-row-id={row.id}
      aria-describedby={detailOpen ? detailRegionId : undefined}
      aria-disabled={busy || undefined}
      tabIndex={-1}
      title={detailAction}
      onClick={(event) => {
        if (
          busy ||
          clickBelongsToNestedControl(event.target, event.currentTarget)
        ) {
          return;
        }
        detailController.toggle(row.id);
      }}
    >
      <span className="review-report__row-check-slot">
        {selectable ? (
          <Checkbox
            dataTestId={`review-row-check-${row.id}`}
            ariaLabel={`Select ${row.title}`}
            checked={selected}
            disabled={busy}
            onChange={() => onToggleRow(row.id)}
          />
        ) : (
          <>
            <span
              className="review-report__row-status-mark"
              data-testid={`review-row-mark-${row.id}`}
              title={status === "pending" ? "manual review required" : status}
              aria-hidden
            >
              {status === "applied" ? "✓" : status === "pending" ? "↗" : "—"}
            </span>
            <span
              className="pc-sr-only"
              data-testid={`review-row-status-${row.id}`}
            >
              {nonSelectableStatusLabel(status)}
            </span>
          </>
        )}
      </span>
      <span className="review-report__row-verb-slot">
        {action != null ? (
          <span
            className={`review-report__verb review-report__verb--${action.tone ?? "apply"}`}
            data-testid={`review-row-verb-${row.id}`}
            data-verb-tone={action.tone ?? "apply"}
            title={action.description ?? action.label}
          >
            {action.icon != null ? (
              <span className="review-report__verb-icon" aria-hidden="true">
                {action.icon}
              </span>
            ) : null}
            <span className="review-report__verb-label">{action.label}</span>
          </span>
        ) : null}
      </span>
      <span className="review-report__row-identity">
        {row.sourceLabel != null ? (
          openSource != null ? (
            <button
              type="button"
              className="review-report__source-chip review-report__source-chip--link"
              data-testid={`review-row-source-${row.id}`}
              aria-label={row.openSourceLabel ?? `Open ${row.sourceLabel}`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                openSource();
              }}
            >
              {row.sourceLabel}
            </button>
          ) : (
            <span
              className="review-report__source-chip review-report__source-chip--static"
              data-testid={`review-row-source-${row.id}`}
            >
              {row.sourceLabel}
            </span>
          )
        ) : null}
        {row.referenceLabel != null ? (
          <span className="review-report__reference">{row.referenceLabel}</span>
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
          <span className="review-report__row-title">{row.title}</span>
        )}
      </span>
      <span className="review-report__row-evidence">
        <span className="review-report__evidence-item">{evidence[0]}</span>
      </span>
      {/* D-001: confidence is NOT editable, so it must not look like a select.
       *  It renders as a static indicator, and the row's one chevron belongs to
       *  the disclosure button beside it — the only control that discloses. */}
      <span
        className={`review-report__row-conf review-report__row-conf--${row.confidence}`}
        data-testid={`review-row-conf-${row.id}`}
        data-confidence={row.confidence}
        title={`Papercup's confidence in this recommendation: ${confidenceLabel}`}
      >
        <span className="review-report__conf-dot" aria-hidden="true" />
        <span className="review-report__conf-label">{confidenceLabel}</span>
        <span className="pc-sr-only">confidence</span>
      </span>
      <button
        type="button"
        className="review-report__row-detail-toggle"
        data-testid={`review-row-why-${row.id}`}
        aria-label={detailAction}
        aria-expanded={detailOpen}
        aria-controls={detailRegionId}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          detailController.toggle(row.id);
        }}
      >
        <span className="review-report__row-detail-toggle-inner">
          <span aria-hidden="true">Why</span>
          <ChevronDown
            size={11}
            className={`review-report__row-detail-chevron${detailOpen ? " review-report__row-detail-chevron--open" : ""}`}
            aria-hidden="true"
          />
        </span>
      </button>
      <span className="review-report__row-menu-slot">
        <ReviewRowMenu
          rowId={row.id}
          rowTitle={row.title}
          actions={row.actions ?? []}
          busy={busy}
        />
      </span>
      {detailOpen ? (
        <div
          className="review-report__row-detail-slot"
          data-testid={`review-row-detail-slot-${row.id}`}
          data-review-detail-region
        >
          <div className="review-report__row-detail-clip">
            <div
              id={detailRegionId}
              className="review-report__row-detail"
              data-testid={`review-row-detail-${row.id}`}
              role="region"
              aria-label={`Details for ${row.title}`}
            >
              <div className="review-report__detail-evidence">
                <strong>Decision evidence</strong>
                <ul>
                  {evidence.map((line, evidenceIndex) => (
                    <li key={`${row.id}-evidence-${evidenceIndex}`}>{line}</li>
                  ))}
                </ul>
              </div>
              {row.detail != null ? (
                <div className="review-report__detail-consumer">
                  {row.detail}
                </div>
              ) : null}
            </div>
          </div>
        </div>
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
});

/**
 * A row's overflow menu (P-008).
 *
 * Open state is `useState`, not nuqs, deliberately: this is a transient
 * pointer/keyboard affordance like a context menu — it closes on Escape, on
 * blur and on any selection — not a user-meaningful panel anyone would
 * deep-link or an agent would drive. The row's DISCLOSURE, which is
 * addressable and persistent, lives in ReviewDetailController instead.
 */
function ReviewRowMenu({
  rowId,
  rowTitle,
  actions,
  busy,
}: {
  rowId: string;
  rowTitle: string;
  actions: readonly ReviewRowMenuAction[];
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        wrapRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Busy closes the menu rather than leaving a live-looking list of controls
  // over an in-flight write.
  useLayoutEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  if (actions.length === 0) return null;

  return (
    <span className="review-report__row-menu" ref={wrapRef}>
      <button
        type="button"
        className="review-report__row-menu-toggle"
        data-testid={`review-row-menu-${rowId}`}
        aria-label={`Actions for ${rowTitle}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((previous) => !previous);
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <span
          className="review-report__row-menu-list"
          data-testid={`review-row-menu-list-${rowId}`}
          role="menu"
          aria-label={`Actions for ${rowTitle}`}
        >
          {actions.map((action) => (
            // The label is deliberately ALWAYS truthy. Tooltip early-returns a bare
            // fragment when `label` is falsy, so a label toggling undefined <-> reason
            // after mount would swap the element TYPE at this JSX position and remount
            // the button, staleing any ref held across it (the hazard that put
            // AgentInspectorModal on BUTTON_TITLE_ALLOWED_FILES). Keeping it non-empty
            // in both states lets us use the shared primitive instead of a native title.
            <Tooltip
              key={action.id}
              label={
                action.disabled === true
                  ? (action.disabledReason ?? "Unavailable")
                  : (action.description ?? action.label)
              }
            >
              <button
                type="button"
                role="menuitem"
                className={`review-report__row-menu-item review-report__row-menu-item--${action.tone ?? "default"}`}
                data-testid={`review-row-menu-${rowId}-${action.id}`}
                disabled={busy || action.disabled === true}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  action.run();
                }}
              >
                {action.label}
              </button>
            </Tooltip>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export default function ReviewReportShell({
  title,
  icon,
  subtitle,
  groups,
  defaultSelected = "pending",
  collapseNonSelectableByDefault = false,
  applyLabel = "Apply selected",
  dismissLabel = "Dismiss",
  runBar,
  revealRequest = null,
  busy = false,
  footer,
  onApply,
  onDismiss,
}: ReviewReportShellProps) {
  const titleId = useId();
  const summaryTitleId = useId();
  const [selected, setSelected] = useState<Set<string>>(() =>
    initialSelection(groups, defaultSelected),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    collapseNonSelectableByDefault
      ? new Set(
          groups
            .filter((group) => !group.rows.some(rowSelectable))
            .map((group) => group.id),
        )
      : new Set(),
  );
  const [detailController] = useState(() => new ReviewDetailController());
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

  useLayoutEffect(
    () => () => {
      detailController.dispose();
    },
    [detailController],
  );

  const pendingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of groups)
      for (const r of g.rows) if (rowSelectable(r)) ids.add(r.id);
    return ids;
  }, [groups]);

  const partition = useMemo(() => partitionReviewRows(groups), [groups]);

  // Service the run bar's `reveal` intent. Keyed on `seq` alone: re-revealing
  // the SAME group is the common case (click "Show only failures" twice after
  // scrolling away), and a groupId-keyed effect would silently do nothing.
  const revealSeq = revealRequest?.seq ?? null;
  const revealGroupId = revealRequest?.groupId ?? null;
  useLayoutEffect(() => {
    if (revealSeq === null || revealGroupId === null) return;
    setCollapsed((previous) => {
      if (!previous.has(revealGroupId)) return previous;
      const next = new Set(previous);
      next.delete(revealGroupId);
      return next;
    });
    const toggle = groupToggleNodes.current.get(revealGroupId);
    if (!toggle) return;
    toggle.scrollIntoView({ block: "start", behavior: "smooth" });
    toggle.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seq` is the
    // request identity; re-running on groupId alone would drop repeat requests.
  }, [revealSeq]);

  const presentRowIds = useMemo(
    () => new Set(groups.flatMap((group) => group.rows.map((row) => row.id))),
    [groups],
  );

  // A live report can remove a row and later reintroduce the same stable id.
  // Once it leaves, stale disclosure state must not resurrect its detail.
  useLayoutEffect(() => {
    detailController.prune(presentRowIds);
  }, [detailController, presentRowIds]);

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

    // A FAILED apply focuses the first failed row, not the header buttons
    // (P-010). Failed rows leave the pending pool, which empties the selection
    // — and the old rule ("nothing selected ⇒ focus Dismiss") then parked
    // keyboard focus on CLOSE immediately after a failure, inviting the owner
    // to discard the only surface naming what did not land. The row it lands on
    // carries the reason and the retry menu.
    const firstErroredRowId = groups
      .flatMap((group) => group.rows)
      .find((row) => row.error != null)?.id;
    if (action === "apply" && firstErroredRowId != null) {
      const rowNode = rowNodes.current.get(firstErroredRowId);
      if (rowNode) {
        rowNode.focus({ preventScroll: true });
        return;
      }
    }

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

  const registerRowNode = useCallback(
    (rowId: string, node: HTMLLIElement | null) => {
      if (node) rowNodes.current.set(rowId, node);
      else rowNodes.current.delete(rowId);
    },
    [],
  );

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
    detailController.clear();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
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
        if (next !== null && next !== document.body) {
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

      {runBar}

      <section
        className="review-report__summary"
        data-testid="review-report-summary"
        aria-labelledby={summaryTitleId}
      >
        <h3 id={summaryTitleId} className="pc-sr-only">
          Report result accounting
        </h3>
        <dl className="review-report__metrics">
          <div className="review-report__metric review-report__metric--results">
            <dt>Findings</dt>
            <dd data-testid="review-report-results-count">
              {partition.results}
            </dd>
          </div>
          {REVIEW_PARTITION_TILES.map((tile) => (
            <div
              key={tile.id}
              className={`review-report__metric review-report__metric--${tile.id}`}
              title={tile.hint}
            >
              <dt>{tile.label}</dt>
              <dd data-testid={`review-report-${tile.id}-count`}>
                {tile.read(partition)}
              </dd>
            </div>
          ))}
        </dl>
        <p
          className="pc-sr-only"
          data-testid="review-report-accounting-invariant"
        >
          {partition.results} results accounted for: {partition.ready} ready,{" "}
          {partition.handled} handled, {partition.manual} manual,{" "}
          {partition.notAssessed} not assessed, and {partition.notApplied} not
          applied.
        </p>
      </section>

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
                  {group.rows.map((row, rowIndex) => (
                    <ReviewReportRowView
                      key={row.id}
                      row={row}
                      detailRegionId={`${titleId}-detail-${index}-${rowIndex}`}
                      selected={liveSelected.has(row.id)}
                      busy={busy}
                      detailController={detailController}
                      registerRowNode={registerRowNode}
                      onToggleRow={toggleRow}
                    />
                  ))}
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
