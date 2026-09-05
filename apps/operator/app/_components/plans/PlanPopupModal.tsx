"use client";

/**
 * PlanPopupModal (owner-plans-single-pane-2026-07-17 P-003) — the plan opened
 * as a POPUP from the sidebar Plans face, instead of a navigation.
 *
 * READ-FIRST (D-001): the body is the SAME PlanDetail the Create tab renders
 * (4th mount context — /admin/plans, MainViewPanel, PlanEditorPanel, here),
 * which already defaults to its read/preview pane; editing stays one click
 * away inside the component. Tracking ≠ authoring — the Create dock keeps the
 * authoring posture.
 *
 * Known re-host traps, both handled (the dock's clipping lesson):
 *   - PlanDetail relies on a `.pc-plans__main` scroller for its overflow —
 *     provided here by `.plan-popup__body` (see plans-pane.css);
 *   - a dirty editor must not be silently discarded on close — PlanDetail's
 *     onDirtyChange feeds the useConfirmDialog guard (MainViewPanel pattern).
 *
 * Second tab (P-005): Sessions — every agent session that touched this plan,
 * with transcript search (PlanSessionsTab). Tab state is `?ppv` (nuqs, D-003)
 * so the popup is deep-linkable + agent-driveable.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { Modal } from "@/app/harness/Modal";
import { Tooltip } from "@/app/harness/Tooltip";
import PlanDetail from "@/app/admin/plans/PlanDetail";
import { usePlanList, type AuthorIdentity } from "@/app/admin/plans/plans-api";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import PlanSessionsTab from "./PlanSessionsTab";
import PlanProvenanceBadge from "./PlanProvenanceBadge";
// PlanDetail's chrome (pc-plans__*) is global CSS; importing it here makes the
// popup self-sufficient wherever the sidebar mounts (InboxPane precedent).
import "@/app/admin/plans/plans.css";
import "./plans-pane.css";

const POPUP_VIEWS = ["plan", "sessions"] as const;
export type PlanPopupView = (typeof POPUP_VIEWS)[number];

/** A not-yet-attached ref and an idle Fullscreen API are both null during
 * hydration. They must not compare as an active fullscreen relationship. */
export function isPopupSurfaceFullscreen(
  fullscreenElement: Element | null,
  surface: HTMLElement | null,
): boolean {
  return surface !== null && fullscreenElement === surface;
}

export default function PlanPopupModal({
  planSlug,
  harnessSlug,
  planTitle,
  origin,
  ownerIdentity,
  onClose,
}: {
  /** The open plan — null renders nothing (closed). */
  planSlug: string | null;
  /** The plan's OWN harness (from the loaded list row) — scoping plans:get to
   *  the wrong harness is the Create tab's old "Server: not_found" trap. */
  harnessSlug: string | null;
  planTitle?: string | null;
  /** Canonical plan-content provenance projected by plans:list. Callers that
   *  already hold the row pass it; global URL-driven callers omit it and this
   *  lazy boundary resolves the same canonical row itself. */
  origin?: "scout" | null;
  /** Resolved plan-owner identity from the same plans.list row. Omitted global
   * callers resolve it alongside origin inside this lazy boundary. */
  ownerIdentity?: AuthorIdentity | null;
  onClose: () => void;
}) {
  const [view, setView] = useQueryState(
    "ppv",
    parseAsStringEnum<PlanPopupView>([...POPUP_VIEWS]).withDefault("plan"),
  );
  const [, setPlanTarget] = useQueryState("jump", parseAsString);
  const dirtyRef = useRef(false);
  const popupSurfaceRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // `wppop` carries only the stable scoped identity (`harness::slug`). The
  // router-root ChatRefPopupHost must stay tiny, so it cannot eagerly import
  // plans.list just to decorate this lazy popup. Resolve the missing fields
  // here, inside the chunk that already owns the heavy plan data stack. An
  // explicit null is authoritative User provenance / absent owner; only
  // undefined means the caller did not have that part of the row. Blender does
  // not need an owner lookup because its visible label is fixed.
  const needsProvenanceLookup =
    planSlug !== null &&
    (origin === undefined ||
      (origin !== "scout" && ownerIdentity === undefined));
  const planList = usePlanList({
    includeArchived: true,
    includeLegacy: true,
    harness_slugs: harnessSlug ? [harnessSlug] : undefined,
    enabled: needsProvenanceLookup,
  });
  const provenancePlan = useMemo(
    () =>
      needsProvenanceLookup
        ? ((planList.data?.plans ?? []).find(
            (plan) =>
              plan.slug === planSlug &&
              (!harnessSlug || plan.harness === harnessSlug),
          ) ?? null)
        : null,
    [harnessSlug, needsProvenanceLookup, planList.data, planSlug],
  );
  const provenanceResolved =
    origin === "scout" ||
    (origin !== undefined && ownerIdentity !== undefined) ||
    provenancePlan !== null;
  const resolvedOrigin = origin !== undefined ? origin : provenancePlan?.origin;
  const resolvedOwnerIdentity =
    ownerIdentity !== undefined
      ? ownerIdentity
      : (provenancePlan?.ownerIdentity ?? null);

  const open = planSlug !== null;
  const fullscreenAvailable =
    typeof document !== "undefined" &&
    document.fullscreenEnabled !== false &&
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.requestFullscreen === "function" &&
    typeof document.exitFullscreen === "function";

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      setIsFullscreen(false);
      return;
    }
    const sync = () => {
      setIsFullscreen(
        isPopupSurfaceFullscreen(
          document.fullscreenElement,
          popupSurfaceRef.current,
        ),
      );
    };
    document.addEventListener("fullscreenchange", sync);
    sync();
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [open]);

  const toggleFullscreen = async () => {
    const target = popupSurfaceRef.current;
    if (!target || !fullscreenAvailable) return;
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === target) {
        await document.exitFullscreen();
        return;
      }
      await target.requestFullscreen();
    } catch {
      setFullscreenError(
        "The browser did not allow fullscreen for this popup.",
      );
    }
  };

  const reallyClose = () => {
    dirtyRef.current = false;
    if (
      typeof document !== "undefined" &&
      document.fullscreenElement === popupSurfaceRef.current
    ) {
      void document.exitFullscreen().catch(() => {});
    }
    void setView(null); // drop ?ppv so the next open lands on the Plan tab
    void setPlanTarget(null); // a later open must not inherit a stale P/D jump
    onClose();
  };

  const guardedClose = () => {
    if (dirtyRef.current) {
      void askConfirm({
        title: "Discard unsaved edits?",
        body: "Your current plan edits will be discarded.",
        confirmLabel: "Discard",
        destructive: true,
      }).then((ok) => {
        if (ok) reallyClose();
      });
      return;
    }
    reallyClose();
  };

  return (
    <>
      {open ? (
        <Modal
          open
          onOpenChange={(o) => {
            if (!o) guardedClose();
          }}
          title={planTitle ?? planSlug ?? "Plan"}
          srOnlyTitle
          contentClassName="plan-popup"
          contentStyle={{
            width: "min(1100px, 94vw)",
            height: "min(860px, calc(100vh - 4rem))",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            padding: 0,
          }}
        >
          <div
            ref={popupSurfaceRef}
            className="plan-popup__surface"
            data-testid="plan-popup-fullscreen-surface"
          >
            <div className="plan-popup__header">
              <div className="plan-popup__identity">
                <div
                  className="plan-popup__title"
                  title={planSlug ?? undefined}
                >
                  {planTitle ?? planSlug}
                </div>
                {provenanceResolved ? (
                  <PlanProvenanceBadge
                    origin={resolvedOrigin ?? null}
                    ownerIdentity={resolvedOwnerIdentity}
                    testId="plan-popup-provenance-badge"
                  />
                ) : null}
              </div>
              <div
                className="plan-popup__tabs"
                role="tablist"
                aria-label="Plan popup view"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "plan"}
                  className={`plan-popup__tab${view === "plan" ? " is-on" : ""}`}
                  onClick={() => void setView("plan")}
                  data-testid="plan-popup-tab-plan"
                >
                  Plan
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "sessions"}
                  className={`plan-popup__tab${view === "sessions" ? " is-on" : ""}`}
                  onClick={() => void setView("sessions")}
                  data-testid="plan-popup-tab-sessions"
                >
                  Sessions
                </button>
              </div>
              <Tooltip
                side="bottom"
                label={
                  fullscreenError ??
                  (fullscreenAvailable
                    ? isFullscreen
                      ? "Restore plan popup"
                      : "View plan fullscreen"
                    : "Fullscreen is not available in this browser")
                }
              >
                <button
                  type="button"
                  className="plan-popup__fullscreen"
                  onClick={() => void toggleFullscreen()}
                  disabled={!fullscreenAvailable}
                  aria-label={
                    isFullscreen ? "Exit fullscreen" : "Enter fullscreen"
                  }
                  aria-pressed={isFullscreen}
                  title={
                    fullscreenAvailable
                      ? undefined
                      : "Fullscreen is not available in this browser"
                  }
                  data-testid="plan-popup-fullscreen"
                >
                  {isFullscreen ? (
                    <Minimize2 size={14} aria-hidden="true" />
                  ) : (
                    <Maximize2 size={14} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
              <button
                type="button"
                className="plan-popup__close"
                onClick={guardedClose}
                aria-label="Close plan popup"
                data-testid="plan-popup-close"
              >
                ✕
              </button>
            </div>
            {view === "sessions" ? (
              <PlanSessionsTab planSlug={planSlug!} harnessSlug={harnessSlug} />
            ) : (
              <div
                className="pc-plans__main plan-popup__body"
                data-testid="plan-popup-body"
              >
                <PlanDetail
                  key={planSlug}
                  slug={planSlug!}
                  harnessSlug={harnessSlug}
                  showBack={false}
                  onClose={guardedClose}
                  onDirtyChange={(d: boolean) => {
                    dirtyRef.current = d;
                  }}
                  startStatus={null}
                  onStartStatusChange={() => {}}
                  onPlanStatusChange={() => {}}
                />
              </div>
            )}
          </div>
        </Modal>
      ) : null}
      {confirmEl}
    </>
  );
}
