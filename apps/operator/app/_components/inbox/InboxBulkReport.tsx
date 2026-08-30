"use client";

/**
 * Grouped Inbox bulk-resolve report (cleanup-report-flows-2026-08-24 P-008).
 *
 * The report projects the persisted run into the shared ReviewReportShell. A
 * selected row still dispatches through useBulkRunOps.acceptRecommendation —
 * the same resolve-first / record-second hand path the inline card uses. The
 * existing InboxBulkRecommendation remains the per-row detail; its expensive
 * detail-tier attention read mounts only while the shared row is hovered or
 * focus-within.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import { usePlanAttentionItem } from "@/app/admin/plans/plans-api";
import { isNavigateAction } from "@/app/admin/plans/attention-card";
import { KIND_LABEL } from "@/app/admin/plans/PlanOtherList";
import ReviewReportShell, {
  type ReviewReportGroup,
  type ReviewReportRow,
  type ReviewRowConfidence,
  type ReviewRowAccounting,
  type ReviewRowStatus,
} from "../review-report/ReviewReportShell";
import { PERF_INTERACTIONS } from "../perf/perf-marks";
import { useInteractionSettle } from "../perf/use-interaction-settle";
import InboxBulkRecommendation from "./InboxBulkRecommendation";
import {
  canonicalInboxDisposition,
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

function refString(
  ref: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = ref[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Rebuild the smallest AttentionItem the canonical terminal dispatcher needs
 * from the click-time row persisted in attention_bulk_run_items.
 *
 * This is deliberately fail-closed. `item_kind` and `item_ref.kind` were
 * snapshotted together; a legacy/corrupt row that lacks either, or whose two
 * discriminants disagree, stays visible in the report but cannot be selected.
 * DETAIL-only fields (especially `actions`) remain absent until the one active
 * explicitly opened detail hydrates through `plans.attentionItem`.
 */
export function bulkRunItemToAttentionSnapshot(
  runItem: BulkRunItem,
  run?: Pick<BulkRun, "harnessSlug">,
): AttentionItem | null {
  const refKind = runItem.ref?.kind;
  if (
    typeof refKind !== "string" ||
    !runItem.kind ||
    runItem.kind !== refKind
  ) {
    return null;
  }

  const ref = runItem.ref as AttentionItem["ref"];
  const harnessSlug =
    refString(runItem.ref, "harnessSlug") ??
    refString(runItem.ref, "targetHarness") ??
    run?.harnessSlug ??
    undefined;
  const planSlug =
    refKind === "plan-item" ? refString(runItem.ref, "slug") : undefined;
  const itemRef =
    refKind === "plan-item" ? refString(runItem.ref, "itemId") : undefined;

  return {
    id: runItem.itemId,
    kind: refKind as AttentionItem["kind"],
    source: "bulk-run-snapshot",
    ...(harnessSlug ? { harnessSlug } : {}),
    ...(planSlug ? { planSlug } : {}),
    ...(itemRef ? { itemRef } : {}),
    title: runItem.title ?? runItem.itemId,
    body: runItem.rationale ?? "",
    status: runItem.outcome,
    importance: "normal",
    tier: "decision",
    needsHuman: true,
    ...(runItem.ownerAgentId ? { ownerAgentId: runItem.ownerAgentId } : {}),
    triageState: "untriaged",
    ref,
  };
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
  if (runItem.recommendationLabel) return runItem.recommendationLabel;
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
  locallyDismissed: ReadonlySet<string>,
): ReviewRowStatus {
  if (locallyApplied.has(runItem.itemId) || runItem.outcome === "auto_resolved")
    return "applied";
  if (locallyDismissed.has(runItem.itemId) || runItem.outcome === "dismissed")
    return "dismissed";
  return "pending";
}

function reviewAccounting(
  runItem: BulkRunItem,
  status: ReviewRowStatus,
  hasAction: boolean,
): ReviewRowAccounting {
  if (status === "applied") return "handled";
  if (status === "dismissed") return "not-applied";
  if (
    runItem.outcome !== "recommended" &&
    canonicalInboxDisposition(runItem) !== "recommended"
  ) {
    return "not-applied";
  }
  if (runItem.actionId === "answer" || !hasAction) return "manual";
  return "ready";
}

function evidenceLines(runItem: BulkRunItem): string[] {
  const lines: string[] = [];
  if (runItem.recommendation?.label)
    lines.push(`next step · ${runItem.recommendation.label}`);
  if (runItem.recommendation?.responsibility) {
    lines.push(`responsibility · ${runItem.recommendation.responsibility}`);
  }
  if (runItem.recommendation?.confidence) {
    lines.push(`confidence · ${runItem.recommendation.confidence}`);
  }
  if (runItem.evidenceBasis?.length) {
    lines.push(`evidence · ${runItem.evidenceBasis.join("; ")}`);
  }
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

/** Typed recommendations and their persisted projection are authoritative.
 * Legacy rows retain the old high/low value; rows never assessed by the
 * resolver expose insufficient confidence instead of inventing certainty. */
export function inboxBulkReviewConfidence(
  runItem: BulkRunItem,
): ReviewRowConfidence {
  return (
    runItem.recommendation?.confidence ??
    runItem.confidenceLevel ??
    runItem.confidence ??
    "insufficient"
  );
}

function fallbackDetail(runItem: BulkRunItem): ReactNode {
  if (runItem.recommendation) {
    return (
      <>
        <strong>{runItem.recommendation.label}</strong>:{" "}
        {runItem.recommendation.rationale}
        {runItem.recommendation.retryCondition ? (
          <> Retry condition: {runItem.recommendation.retryCondition}</>
        ) : null}
      </>
    );
  }
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
  locallyDismissed: ReadonlySet<string> = new Set(),
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
    const disposition = canonicalInboxDisposition(runItem);
    // Keep the raw skipped key stable for deep links/tests from pre-1015 runs;
    // the human-facing title/evidence still uses the canonical recommendation.
    const groupKey = runItem.outcome === "skipped" ? "skipped" : disposition;
    const groupId = `${runItem.actionId ?? groupKey}:${kind}`;
    let group = grouped.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        title: `${action} · ${kindLabel(kind)}`,
        description: `Run items grouped by next step and source kind.`,
        rows: [],
      };
      grouped.set(groupId, group);
    }

    const status = reviewStatus(runItem, locallyApplied, locallyDismissed);
    const localError = localErrors.get(runItem.itemId);
    const hasAction =
      Boolean(runItem.actionId) &&
      (!isNavigateAction(runItem.actionId!) ||
        (runItem.actionId === "answer" &&
          Boolean(runItem.draftAnswer?.trim())));
    const row: ReviewReportRow = {
      id: runItem.itemId,
      title: item?.title ?? runItem.title ?? runItem.itemId,
      sourceLabel: kindLabel(kind),
      referenceLabel: action,
      evidence: evidenceLines(runItem),
      confidence: inboxBulkReviewConfidence(runItem),
      accounting: reviewAccounting(runItem, status, hasAction && Boolean(item)),
      status,
      selectable:
        status === "pending" &&
        runItem.outcome === "recommended" &&
        hasAction &&
        Boolean(item),
      error: localError,
      detail:
        status === "pending" && item && detailFor
          ? detailFor(item, runItem)
          : fallbackDetail(runItem),
    };
    group.rows.push(row);
  }

  return [...grouped.values()]
    .flatMap((group) => {
      const actionable = group.rows.filter((row) => row.selectable === true);
      const otherResults = group.rows.filter((row) => row.selectable !== true);

      // A completed row can carry the same persisted action id as a still-live
      // recommendation. Keep the actionable rows in the canonical group and
      // move the non-selectable history behind its own existing disclosure;
      // otherwise one live action eagerly mounts every historical detail row.
      if (actionable.length === 0 || otherResults.length === 0) return [group];

      return [
        { ...group, rows: actionable },
        {
          ...group,
          id: `${group.id}:other-results`,
          title: `${group.title} · Other results`,
          description:
            "Already handled or non-selectable results for this action.",
          rows: otherResults,
        },
      ];
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

interface HydratedRecommendationProps {
  listItem: AttentionItem;
  runItem: BulkRunItem;
  busy: boolean;
  onAccept: (
    item: AttentionItem,
    draftOverride: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDiscuss?: (item: AttentionItem) => void;
  onRetry: () => void;
  onDismiss: () => void;
  onReconcile: () => void;
}

function InboxBulkRecoveryActions({
  item,
  busy,
  sourceMissing,
  onOpen,
  onRetry,
  onDismiss,
  onReconcile,
}: {
  item: BulkRunItem;
  busy: boolean;
  sourceMissing: boolean;
  onOpen?: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onReconcile: () => void;
}) {
  return (
    <div className="inbox-bulk-report__recovery">
      <button type="button" disabled={busy || !onOpen} onClick={onOpen}>
        Open source
      </button>
      <button
        type="button"
        data-testid={`inbox-bulk-retry-${item.itemId}`}
        disabled={busy}
        onClick={onRetry}
      >
        Retry
      </button>
      {sourceMissing ? (
        <button
          type="button"
          data-testid={`inbox-bulk-reconcile-${item.itemId}`}
          disabled={busy}
          onClick={onReconcile}
        >
          Mark resolved
        </button>
      ) : null}
      <button
        type="button"
        data-testid={`inbox-bulk-dismiss-item-${item.itemId}`}
        disabled={busy}
        onClick={onDismiss}
      >
        Dismiss item
      </button>
    </div>
  );
}

function HydratedRecommendation({
  listItem,
  runItem,
  busy,
  onAccept,
  onDiscuss,
  onRetry,
  onDismiss,
  onReconcile,
}: HydratedRecommendationProps) {
  const detail = usePlanAttentionItem(listItem.id);
  const actions = (sourceMissing: boolean, openItem?: AttentionItem) => (
    <InboxBulkRecoveryActions
      item={runItem}
      busy={busy}
      sourceMissing={sourceMissing}
      onOpen={onDiscuss && openItem ? () => onDiscuss(openItem) : undefined}
      onRetry={onRetry}
      onDismiss={onDismiss}
      onReconcile={onReconcile}
    />
  );
  if (detail.loading) {
    return (
      <>
        <span
          className="inbox-bulk-report__detail-loading"
          role="status"
          aria-live="polite"
        >
          Loading this item&rsquo;s live options…
        </span>
        {actions(false, listItem)}
      </>
    );
  }
  if (detail.error) {
    return (
      <>
        <span className="inbox-bulk-report__detail-loading" role="alert">
          Could not load this item&rsquo;s current options: {detail.error}
        </span>
        {actions(false, listItem)}
      </>
    );
  }
  if (!detail.data) {
    return (
      <>
        <span className="inbox-bulk-report__detail-loading" role="status">
          This item is no longer available in the live Inbox. If you resolved it
          manually, mark it resolved here; otherwise Retry or dismiss it.
        </span>
        {actions(true, listItem)}
      </>
    );
  }

  const hydratedItem = { ...listItem, ...detail.data };
  return (
    <>
      {runItem.outcome === "recommended" ? (
        <InboxBulkRecommendation
          item={hydratedItem}
          rec={runItem}
          busy={busy}
          onAccept={(draftOverride) => onAccept(hydratedItem, draftOverride)}
          onDiscuss={onDiscuss ? () => onDiscuss(hydratedItem) : undefined}
        />
      ) : (
        <span className="inbox-bulk-report__detail-loading">
          {fallbackDetail(runItem)}
        </span>
      )}
      {actions(false, hydratedItem)}
    </>
  );
}

/** One-at-a-time detail hydration keeps a 200-row report from opening 200
 * detail subscriptions just to render its overview. */
export function InboxBulkRecommendationDetail(
  props: HydratedRecommendationProps,
) {
  return (
    <div
      className="inbox-bulk-report__hover-detail"
      data-testid={`inbox-bulk-detail-${props.runItem.itemId}`}
    >
      <div className="inbox-bulk-report__detail-head">
        <strong>{props.listItem.title}</strong>
        <span>
          Review the live options, adjust the reply if needed, then accept or
          discuss.
        </span>
      </div>
      <HydratedRecommendation {...props} />
    </div>
  );
}

export interface InboxBulkReportProps {
  run: BulkRun;
  runItems: BulkRunItem[];
  onOpenThread?: (item: AttentionItem) => void;
  onClose: () => void;
}

export default function InboxBulkReport({
  run,
  runItems,
  onOpenThread,
  onClose,
}: InboxBulkReportProps) {
  // P-013: the lazy chunk and persisted run have both resolved by the time this
  // component commits. Passive settlement preserves the perf-marks ordering
  // contract; direct/deep-linked mounts have no start and therefore no-op.
  useInteractionSettle(PERF_INTERACTIONS.inboxBulkReportOpen, true);
  const { acceptRecommendation, dismissItem, reconcileItem, resume } =
    useBulkRunOps();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [locallyApplied, setLocallyApplied] = useState<Set<string>>(
    () => new Set(),
  );
  const [locallyDismissed, setLocallyDismissed] = useState<Set<string>>(
    () => new Set(),
  );
  const [localErrors, setLocalErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const attentionById = useMemo(() => {
    const snapshots = new Map<string, AttentionItem>();
    for (const runItem of runItems) {
      const snapshot = bulkRunItemToAttentionSnapshot(runItem, run);
      if (snapshot) snapshots.set(snapshot.id, snapshot);
    }
    return snapshots;
  }, [run.harnessSlug, runItems]);
  const runItemById = useMemo(
    () => new Map(runItems.map((item) => [item.itemId, item])),
    [runItems],
  );

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
      return result;
    },
    [acceptRecommendation, run.runId],
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
        if (result.phase === "complete") onClose();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [applyRecommendation, busy, onClose],
  );

  const clearItemError = useCallback((itemId: string) => {
    setLocalErrors((previous) => {
      if (!previous.has(itemId)) return previous;
      const next = new Map(previous);
      next.delete(itemId);
      return next;
    });
  }, []);

  const retryItem = useCallback(
    async (runItem: BulkRunItem) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await resume(run.runId, [runItem.itemId]);
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              runItem.itemId,
              result.error ?? "The resolver could not retry this item.",
            ),
          );
          return;
        }
        clearItemError(runItem.itemId);
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearItemError, onClose, resume, run.runId],
  );

  const dismissOne = useCallback(
    async (runItem: BulkRunItem) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await dismissItem(
          run.runId,
          runItem.itemId,
          "Owner dismissed this item from the grouped recovery report",
        );
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              runItem.itemId,
              result.error ?? "The item could not be dismissed.",
            ),
          );
          return;
        }
        clearItemError(runItem.itemId);
        setLocallyDismissed((previous) =>
          new Set(previous).add(runItem.itemId),
        );
        if (result.phase === "complete") onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearItemError, dismissItem, onClose, run.runId],
  );

  const reconcileOne = useCallback(
    async (runItem: BulkRunItem) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await reconcileItem(run.runId, runItem.itemId);
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              runItem.itemId,
              result.error ??
                "The manual source resolution could not be recorded.",
            ),
          );
          return;
        }
        clearItemError(runItem.itemId);
        setLocallyApplied((previous) => new Set(previous).add(runItem.itemId));
        if (result.phase === "complete") onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearItemError, onClose, reconcileItem, run.runId],
  );

  const groups = useMemo(
    () =>
      buildInboxBulkReviewGroups(
        runItems,
        attentionById,
        locallyApplied,
        localErrors,
        locallyDismissed,
        (item, runItem) => (
          <InboxBulkRecommendationDetail
            key={runItem.itemId}
            listItem={item}
            runItem={runItem}
            busy={busy}
            onAccept={(hydratedItem, draftOverride) =>
              acceptSingle(hydratedItem, runItem, draftOverride)
            }
            onDiscuss={onOpenThread}
            onRetry={() => void retryItem(runItem)}
            onDismiss={() => void dismissOne(runItem)}
            onReconcile={() => void reconcileOne(runItem)}
          />
        ),
      ),
    [
      runItems,
      attentionById,
      locallyApplied,
      localErrors,
      locallyDismissed,
      busy,
      acceptSingle,
      retryItem,
      dismissOne,
      reconcileOne,
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
                "This run row has no valid persisted dispatch snapshot; resolve it from the current Inbox.",
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

  const counts = deriveRunCounts(runItems, run);
  return (
    <ReviewReportShell
      key={run.runId}
      title="Inbox bulk-resolve report"
      icon={<Sparkles size={19} />}
      subtitle={
        <span className="inbox-bulk-report__subtitle">
          <span>
            {counts.total} assessed · {counts.resolved} auto-resolved ·{" "}
            {counts.unresolved} still open
            <br />
            {counts.recommendationTotal} recommendations · {counts.ownerAction}{" "}
            owner actions · {counts.cleanupCandidate} cleanup ·{" "}
            {counts.retryNeeded + counts.pending} retry needed · {counts.routed}{" "}
            routed · {counts.investigate} investigate
          </span>
          {notice ? (
            <span role="alert" className="inbox-bulk-report__error">
              {notice}
            </span>
          ) : null}
        </span>
      }
      groups={groups}
      collapseNonSelectableByDefault
      busy={busy}
      applyLabel="Apply selected"
      dismissLabel="Close"
      onApply={(ids) => void onApply(ids)}
      onDismiss={onClose}
      footer={
        <span>
          <strong>Resolve-first guarantee.</strong> Selected rows dispatch
          through the same live Inbox action path as a hand resolve, then record
          acceptance on the run. A failed resolve stays visible and unrecorded.
          Click a row—or use its details button—to review the item&rsquo;s
          current options, edit a drafted reply, open the source, Retry, or
          dismiss one row deliberately. Closing the report never completes
          unresolved work.
        </span>
      }
    />
  );
}
