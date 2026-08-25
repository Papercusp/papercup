"use client";

/**
 * Grouped Inbox bulk-resolve report (cleanup-report-flows-2026-08-24 P-008).
 *
 * The report projects the persisted run into the shared ReviewReportShell. A
 * selected row still dispatches through useBulkRunOps.acceptRecommendation —
 * the same resolve-first / record-second hand path the inline card uses. The
 * existing InboxBulkRecommendation remains the per-row drill-in; its expensive
 * detail-tier attention read mounts only when that drill-in is opened.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Sparkles } from "lucide-react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import { useHydratedAttentionItem } from "@/app/admin/plans/plans-api";
import { isNavigateAction } from "@/app/admin/plans/attention-card";
import { KIND_LABEL } from "@/app/admin/plans/PlanOtherList";
import ReviewReportShell, {
  type ReviewReportGroup,
  type ReviewReportRow,
  type ReviewRowStatus,
} from "../review-report/ReviewReportShell";
import InboxBulkRecommendation from "./InboxBulkRecommendation";
import {
  deriveRunCounts,
  useBulkRunOps,
  type BulkAcceptResult,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import "./inbox-bulk-report.css";

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function itemKind(
  item: AttentionItem | undefined,
  runItem: BulkRunItem,
): string {
  return item?.kind ?? runItem.kind ?? "unknown";
}

function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? humanize(kind);
}

function actionLabel(
  item: AttentionItem | undefined,
  runItem: BulkRunItem,
): string {
  const action = runItem.actionId;
  if (action) {
    return (
      item?.actions?.find((candidate) => candidate.id === action)?.label ??
      humanize(action)
    );
  }
  if (runItem.outcome === "pending") return "Not reached";
  if (runItem.outcome === "skipped") return "Skipped";
  if (runItem.outcome === "failed") return "Failed";
  return "Resolved";
}

function reviewStatus(
  runItem: BulkRunItem,
  locallyApplied: ReadonlySet<string>,
): ReviewRowStatus {
  if (locallyApplied.has(runItem.itemId) || runItem.outcome === "auto_resolved")
    return "applied";
  if (runItem.outcome === "recommended" || runItem.outcome === "pending")
    return "pending";
  return "dismissed";
}

function evidenceLines(runItem: BulkRunItem): string[] {
  const lines: string[] = [];
  if (runItem.rationale) lines.push(runItem.rationale);
  if (runItem.consulted) {
    lines.push(
      runItem.consultReply
        ? "Asker replied during consultation."
        : "Asker did not reply during consultation.",
    );
  }
  if (runItem.error) lines.push(`error · ${runItem.error}`);
  if (runItem.actionId) lines.push(`recommended action · ${runItem.actionId}`);
  return lines.length > 0 ? lines : [`run position · ${runItem.position + 1}`];
}

function fallbackDetail(
  runItem: BulkRunItem,
  localError: string | undefined,
): ReactNode {
  if (localError)
    return <span className="inbox-bulk-report__row-error">{localError}</span>;
  if (runItem.outcome === "pending")
    return "The resolver did not reach this item before the run settled.";
  if (runItem.outcome === "skipped")
    return (
      runItem.rationale ?? "The resolver could not safely recommend an action."
    );
  if (runItem.outcome === "failed")
    return runItem.error ?? "The resolver failed while evaluating this item.";
  if (runItem.outcome === "auto_resolved")
    return (
      runItem.rationale ?? "Resolved automatically with recorded evidence."
    );
  return null;
}

/** Pure run → grouped-report projection. Exported so the grouping, statuses,
 * and selectable policy are pinned independently from network behavior. */
export function buildInboxBulkReviewGroups(
  runItems: readonly BulkRunItem[],
  attentionById: ReadonlyMap<string, AttentionItem>,
  locallyApplied: ReadonlySet<string> = new Set(),
  localErrors: ReadonlyMap<string, string> = new Map(),
  detailFor?: (item: AttentionItem, runItem: BulkRunItem) => ReactNode,
): ReviewReportGroup[] {
  const grouped = new Map<string, ReviewReportGroup>();
  const ordered = [...runItems].sort(
    (a, b) => a.position - b.position || a.itemId.localeCompare(b.itemId),
  );

  for (const runItem of ordered) {
    const item = attentionById.get(runItem.itemId);
    const kind = itemKind(item, runItem);
    const action = actionLabel(item, runItem);
    const groupId = `${runItem.actionId ?? runItem.outcome}:${kind}`;
    let group = grouped.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        title: `${action} · ${kindLabel(kind)}`,
        description: `Run items grouped by the recommended action and source kind.`,
        rows: [],
      };
      grouped.set(groupId, group);
    }

    const status = reviewStatus(runItem, locallyApplied);
    const localError = localErrors.get(runItem.itemId);
    const hasAction =
      Boolean(runItem.actionId) && !isNavigateAction(runItem.actionId!);
    const row: ReviewReportRow = {
      id: runItem.itemId,
      title: item?.title ?? runItem.title ?? runItem.itemId,
      sourceLabel: kindLabel(kind),
      referenceLabel: action,
      evidence: evidenceLines(runItem),
      confidence:
        runItem.outcome === "auto_resolved" ? "provable" : "recommended",
      status,
      selectable:
        status === "pending" &&
        runItem.outcome === "recommended" &&
        hasAction &&
        Boolean(item),
      detail:
        runItem.outcome === "recommended" && item && detailFor
          ? detailFor(item, runItem)
          : fallbackDetail(runItem, localError),
    };
    group.rows.push(row);
  }

  return [...grouped.values()].sort((a, b) => a.title.localeCompare(b.title));
}

interface HydratedRecommendationProps {
  listItem: AttentionItem;
  runItem: BulkRunItem;
  busy: boolean;
  onAccept: (
    draftOverride: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDiscuss?: () => void;
}

function HydratedRecommendation({
  listItem,
  runItem,
  busy,
  onAccept,
  onDiscuss,
}: HydratedRecommendationProps) {
  const hydrated = useHydratedAttentionItem(listItem);
  if (!hydrated.hydrated || !hydrated.item) {
    return (
      <span
        className="inbox-bulk-report__detail-loading"
        role="status"
        aria-live="polite"
      >
        Loading this item&rsquo;s live options…
      </span>
    );
  }
  return (
    <InboxBulkRecommendation
      item={hydrated.item}
      rec={runItem}
      busy={busy}
      onAccept={onAccept}
      onDiscuss={onDiscuss}
    />
  );
}

export interface InboxBulkRecommendationDrillInProps extends HydratedRecommendationProps {
  open: boolean;
  onToggle: () => void;
  /** Gives the report a stable focus target after a successful inline accept
   * removes the currently focused decision desk. */
  onToggleNode?: (node: HTMLButtonElement | null) => void;
}

/** One-at-a-time detail hydration keeps a 200-row report from opening 200
 * detail subscriptions just to render its overview. */
export function InboxBulkRecommendationDrillIn(
  props: InboxBulkRecommendationDrillInProps,
) {
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  return (
    <span
      className={`inbox-bulk-report__drill${props.open ? " inbox-bulk-report__drill--open" : ""}`}
    >
      <button
        ref={(node) => {
          toggleRef.current = node;
          props.onToggleNode?.(node);
        }}
        type="button"
        className="inbox-bulk-report__drill-toggle"
        data-testid={`inbox-bulk-drill-${props.runItem.itemId}`}
        aria-expanded={props.open}
        aria-controls={`inbox-bulk-decision-desk-${props.runItem.itemId}`}
        onClick={props.onToggle}
      >
        {props.open ? "Close decision desk" : "Open decision desk"}
      </button>
      {props.open ? (
        <span
          id={`inbox-bulk-decision-desk-${props.runItem.itemId}`}
          className="inbox-bulk-report__decision-desk"
          data-testid={`inbox-bulk-decision-desk-${props.runItem.itemId}`}
          role="region"
          aria-label={`Decision desk for ${props.listItem.title}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            // Focus the surviving disclosure trigger before unmounting the
            // region so keyboard users never fall back to <body>.
            toggleRef.current?.focus({ preventScroll: true });
            props.onToggle();
          }}
        >
          <span className="inbox-bulk-report__decision-desk-head">
            <span className="inbox-bulk-report__decision-desk-kicker">
              Focused decision
            </span>
            <strong>{props.listItem.title}</strong>
            <span>
              Review the live options, adjust the reply if needed, then accept
              or discuss.
            </span>
          </span>
          <HydratedRecommendation {...props} />
        </span>
      ) : null}
    </span>
  );
}

export interface InboxBulkReportProps {
  run: BulkRun;
  runItems: BulkRunItem[];
  attentionItems: AttentionItem[];
  onRefresh?: () => void;
  onOpenThread?: (item: AttentionItem) => void;
  onClose: () => void;
}

export default function InboxBulkReport({
  run,
  runItems,
  attentionItems,
  onRefresh,
  onOpenThread,
  onClose,
}: InboxBulkReportProps) {
  const { acceptRecommendation, dismiss } = useBulkRunOps();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeDrillId, setActiveDrillId] = useState<string | null>(null);
  const drillToggleNodes = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusRestoreId = useRef<string | null>(null);
  const [locallyApplied, setLocallyApplied] = useState<Set<string>>(
    () => new Set(),
  );
  const [localErrors, setLocalErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const attentionById = useMemo(
    () => new Map(attentionItems.map((item) => [item.id, item])),
    [attentionItems],
  );
  const runItemById = useMemo(
    () => new Map(runItems.map((item) => [item.itemId, item])),
    [runItems],
  );

  useEffect(() => {
    if (activeDrillId !== null) return;
    const itemId = pendingFocusRestoreId.current;
    if (!itemId) return;
    pendingFocusRestoreId.current = null;
    drillToggleNodes.current.get(itemId)?.focus({ preventScroll: true });
  }, [activeDrillId]);

  const applyRecommendation = useCallback(
    async (
      item: AttentionItem,
      runItem: BulkRunItem,
      draftOverride?: string | null,
    ): Promise<BulkAcceptResult> => {
      const effective =
        draftOverride === undefined
          ? runItem
          : { ...runItem, draftAnswer: draftOverride };
      const result = await acceptRecommendation(run.runId, item, effective);
      if (!result.ok) {
        setLocalErrors((previous) =>
          new Map(previous).set(
            runItem.itemId,
            result.error ?? "The item did not accept that action.",
          ),
        );
        return result;
      }
      setLocallyApplied((previous) => new Set(previous).add(runItem.itemId));
      setLocalErrors((previous) => {
        const next = new Map(previous);
        next.delete(runItem.itemId);
        return next;
      });
      onRefresh?.();
      return result;
    },
    [acceptRecommendation, onRefresh, run.runId],
  );

  const acceptSingle = useCallback(
    async (
      item: AttentionItem,
      runItem: BulkRunItem,
      draftOverride: string | null,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (busy)
        return {
          ok: false,
          error: "Another report action is already running.",
        };
      setBusy(true);
      setNotice(null);
      try {
        const result = await applyRecommendation(item, runItem, draftOverride);
        if (result.ok) {
          pendingFocusRestoreId.current = runItem.itemId;
          setActiveDrillId(null);
        }
        if (result.phase === "complete") onClose();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [applyRecommendation, busy, onClose],
  );

  const groups = useMemo(
    () =>
      buildInboxBulkReviewGroups(
        runItems,
        attentionById,
        locallyApplied,
        localErrors,
        (item, runItem) => (
          <InboxBulkRecommendationDrillIn
            key={runItem.itemId}
            listItem={item}
            runItem={runItem}
            busy={busy}
            open={activeDrillId === runItem.itemId}
            onToggleNode={(node) => {
              if (node) drillToggleNodes.current.set(runItem.itemId, node);
              else drillToggleNodes.current.delete(runItem.itemId);
            }}
            onToggle={() =>
              setActiveDrillId((current) =>
                current === runItem.itemId ? null : runItem.itemId,
              )
            }
            onAccept={(draftOverride) =>
              acceptSingle(item, runItem, draftOverride)
            }
            onDiscuss={onOpenThread ? () => onOpenThread(item) : undefined}
          />
        ),
      ),
    [
      runItems,
      attentionById,
      locallyApplied,
      localErrors,
      busy,
      activeDrillId,
      acceptSingle,
      onOpenThread,
    ],
  );

  const onApply = useCallback(
    async (selectedIds: string[]) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const selected = selectedIds
          .map((id) => runItemById.get(id))
          .filter((item): item is BulkRunItem => Boolean(item))
          .sort((a, b) => a.position - b.position);
        for (const runItem of selected) {
          const item = attentionById.get(runItem.itemId);
          if (!item) {
            setLocalErrors((previous) =>
              new Map(previous).set(
                runItem.itemId,
                "This item is no longer in the live attention feed; resolve it from the Inbox.",
              ),
            );
            continue;
          }
          const result = await applyRecommendation(item, runItem);
          if (result.phase === "complete") {
            onClose();
            break;
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [applyRecommendation, attentionById, busy, onClose, runItemById],
  );

  const onDismiss = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await dismiss(run.runId);
      onClose();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, dismiss, onClose, run.runId]);

  const counts = deriveRunCounts(runItems, run);
  return (
    <ReviewReportShell
      key={run.runId}
      title="Inbox bulk-resolve report"
      icon={<Sparkles size={19} />}
      subtitle={
        <span className="inbox-bulk-report__subtitle">
          <span>
            {counts.forReview} need your call · {counts.resolved} auto-resolved
            · {counts.skipped + counts.failed} need manual follow-up
          </span>
          {notice ? (
            <span role="alert" className="inbox-bulk-report__error">
              {notice}
            </span>
          ) : null}
        </span>
      }
      groups={groups}
      busy={busy}
      applyLabel="Apply selected"
      dismissLabel="Dismiss report"
      onApply={(ids) => void onApply(ids)}
      onDismiss={() => void onDismiss()}
      footer={
        <span>
          <strong>Resolve-first guarantee.</strong> Selected rows dispatch
          through the same live Inbox action path as a hand resolve, then record
          acceptance on the run. A failed resolve stays visible and unrecorded.
          Open one <em>decision desk</em> at a time to load the item&rsquo;s
          current options, edit a drafted reply, or open its discussion.
        </span>
      }
    />
  );
}
