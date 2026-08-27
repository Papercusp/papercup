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
 * hover/focus detail hydrates through `plans.attentionItem`.
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

function fallbackDetail(runItem: BulkRunItem): ReactNode {
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
      confidence:
        runItem.outcome === "auto_resolved" ? "provable" : "recommended",
      status,
      selectable:
        status === "pending" &&
        runItem.outcome === "recommended" &&
        hasAction &&
        Boolean(item),
      error: localError,
      detail:
        status === "pending" &&
        runItem.outcome === "recommended" &&
        item &&
        detailFor
          ? detailFor(item, runItem)
          : fallbackDetail(runItem),
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
    item: AttentionItem,
    draftOverride: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDiscuss?: (item: AttentionItem) => void;
}

function HydratedRecommendation({
  listItem,
  runItem,
  busy,
  onAccept,
  onDiscuss,
}: HydratedRecommendationProps) {
  const detail = usePlanAttentionItem(listItem.id);
  if (detail.loading) {
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
  if (detail.error) {
    return (
      <span className="inbox-bulk-report__detail-loading" role="alert">
        Could not load this item&rsquo;s current options: {detail.error}
      </span>
    );
  }
  if (!detail.data) {
    return (
      <span className="inbox-bulk-report__detail-loading" role="alert">
        This item is no longer available in the live Inbox. Nothing was applied;
        resolve it from the current Inbox if it reappears.
      </span>
    );
  }

  const hydratedItem = { ...listItem, ...detail.data };
  return (
    <InboxBulkRecommendation
      item={hydratedItem}
      rec={runItem}
      busy={busy}
      onAccept={(draftOverride) => onAccept(hydratedItem, draftOverride)}
      onDiscuss={onDiscuss ? () => onDiscuss(hydratedItem) : undefined}
    />
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
  const { acceptRecommendation, dismiss } = useBulkRunOps();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [locallyApplied, setLocallyApplied] = useState<Set<string>>(
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

  const groups = useMemo(
    () =>
      buildInboxBulkReviewGroups(
        runItems,
        attentionById,
        locallyApplied,
        localErrors,
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
          />
        ),
      ),
    [
      runItems,
      attentionById,
      locallyApplied,
      localErrors,
      busy,
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
      dismissLabel="Dismiss"
      onApply={(ids) => void onApply(ids)}
      onDismiss={() => void onDismiss()}
      footer={
        <span>
          <strong>Resolve-first guarantee.</strong> Selected rows dispatch
          through the same live Inbox action path as a hand resolve, then record
          acceptance on the run. A failed resolve stays visible and unrecorded.
          Hover a row—or focus its checkbox—to review the item&rsquo;s current
          options, edit a drafted reply, or open its discussion.
        </span>
      }
    />
  );
}
