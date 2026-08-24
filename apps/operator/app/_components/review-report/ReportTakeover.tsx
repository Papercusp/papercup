'use client';

/**
 * ReportTakeover (cleanup-report-flows-2026-08-24 P-001) — the app-pane
 * TAKEOVER chrome + nuqs-param helper shared by every report-review surface,
 * mirroring the PlanDashboardHost pattern (plan-visibility-revamp D-002): a
 * full-width layer over the routed <main> content while the routed page stays
 * MOUNTED underneath — back (clear the param) restores it with state intact,
 * which is what makes this a takeover rather than a navigation.
 *
 * The param KEY belongs to the consumer (one key per renderer — `?opcln=` for
 * the plan-cleanup review, the inbox review's own key for P-008), exactly as
 * pdash/pplan/wppop each own theirs. This module only standardizes the wiring
 * so state lives in the URL (nuqs, never useState — the agent → UI control
 * surface reads the URL) and the layer geometry/styling stays identical across
 * consumers.
 */
import { type ReactNode } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import './review-report.css';

export interface ReportTakeoverParam {
  /** The raw param value (consumer-defined grammar), null when closed. */
  value: string | null;
  open: boolean;
  /** Open the takeover with a value (a run ref, a phase, …). */
  show: (value: string) => void;
  /** Clear the param — the routed page underneath resumes untouched. */
  close: () => void;
}

/** nuqs wiring for a report-takeover param. URL-owned on purpose: the takeover
 *  open/closed state is user-meaningful (deep-linkable, agent-visible via
 *  ui:get_state), unlike the in-review checkbox drafts which stay useState. */
export function useReportTakeoverParam(paramKey: string): ReportTakeoverParam {
  const [value, setValue] = useQueryState(paramKey, parseAsString);
  return {
    value,
    open: value !== null,
    show: (v: string) => void setValue(v),
    close: () => void setValue(null),
  };
}

export interface ReportTakeoverLayerProps {
  children: ReactNode;
  /** Override the default testid when two takeovers could coexist in one DOM. */
  testId?: string;
}

/** The takeover layer itself. Mount it (conditionally, when the param is set)
 *  inside `<main data-route-transition-page>` as a SIBLING of the routed
 *  content — same slot as `.plan-dash-takeover`. */
export function ReportTakeoverLayer({ children, testId = 'report-takeover' }: ReportTakeoverLayerProps) {
  return (
    <div className="review-report-takeover" data-testid={testId}>
      {children}
    </div>
  );
}
