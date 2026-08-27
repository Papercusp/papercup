"use client";

/** URL-owned app-pane host for the P-007 grouped plan clean-up report. */
import { Suspense, useCallback } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { FLAGS } from "@papercusp/flags";
import { lazyWithRetry as lazy } from "@papercusp/operator-core/lib/lazy-with-retry";
import { useFlag } from "@/lib/flag-hooks";
import {
  ReportTakeoverLayer,
  useReportTakeoverParam,
} from "../review-report/ReportTakeover";
import {
  PLAN_CLEANUP_RUN_PARAM,
  usePlanCleanupRun,
  type PlanCleanupFinding,
} from "./use-plan-cleanup-run";
import { encodeScopedRef } from "../chat/chat-ref-popup-params";
import { PLAN_DASHBOARD_PARAM } from "./PlanDashboardHost";
import "./plan-cleanup-report.css";

const PlanCleanupReport = lazy(() => import("./PlanCleanupReport"));

export default function PlanCleanupReportHost() {
  const enabled = useFlag(FLAGS.PLAN_CLEANUP);
  const report = useReportTakeoverParam(PLAN_CLEANUP_RUN_PARAM);
  const cleanup = usePlanCleanupRun(report.value, {
    enabled: enabled && report.foreground,
  });
  const [, setDashboardPlan] = useQueryState(
    PLAN_DASHBOARD_PARAM,
    parseAsString,
  );
  const openFinding = useCallback(
    (finding: PlanCleanupFinding) => {
      void (async () => {
        await report.close();
        await setDashboardPlan(
          encodeScopedRef(finding.harnessSlug, finding.planSlug),
        );
      })();
    },
    [report, setDashboardPlan],
  );

  // `?opcln=` is also the running-run deep link. It becomes a takeover only
  // once the persisted phase reaches review; pending/running stays in the strip.
  if (
    !enabled ||
    !report.foreground ||
    !report.value ||
    cleanup.run?.phase !== "review"
  ) {
    return null;
  }

  return (
    <ReportTakeoverLayer testId="plan-cleanup-report-takeover">
      <Suspense
        fallback={
          <div
            className="plan-cleanup-report__loading"
            role="status"
            aria-live="polite"
          >
            Loading clean-up report…
          </div>
        }
      >
        <PlanCleanupReport
          key={cleanup.run.runId}
          run={cleanup.run}
          findings={cleanup.findings}
          onOpenFinding={openFinding}
          onClose={report.close}
        />
      </Suspense>
    </ReportTakeoverLayer>
  );
}
