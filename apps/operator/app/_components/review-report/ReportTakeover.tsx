"use client";

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
import { useEffect, useRef, type ReactNode } from "react";
import { parseAsString, useQueryState } from "nuqs";
import "./review-report.css";

interface IsolatedSiblingState {
  count: number;
  inert: string | null;
  ariaHidden: string | null;
}

interface TakeoverParentState {
  count: number;
  restoreFocus: HTMLElement | null;
}

/** Multiple URL-owned takeovers can briefly coexist. Reference counts keep one
 * layer from exposing the routed page while another layer still covers it. */
const isolatedSiblings = new WeakMap<HTMLElement, IsolatedSiblingState>();
const takeoverParents = new WeakMap<HTMLElement, TakeoverParentState>();

function isolateSibling(node: HTMLElement): void {
  const existing = isolatedSiblings.get(node);
  if (existing) {
    existing.count += 1;
    return;
  }
  isolatedSiblings.set(node, {
    count: 1,
    inert: node.getAttribute("inert"),
    ariaHidden: node.getAttribute("aria-hidden"),
  });
  node.setAttribute("inert", "");
  node.setAttribute("aria-hidden", "true");
}

function releaseSibling(node: HTMLElement): void {
  const state = isolatedSiblings.get(node);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  isolatedSiblings.delete(node);
  if (state.inert === null) node.removeAttribute("inert");
  else node.setAttribute("inert", state.inert);
  if (state.ariaHidden === null) node.removeAttribute("aria-hidden");
  else node.setAttribute("aria-hidden", state.ariaHidden);
}

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
  /** Accessible name for the app-pane region. */
  label?: string;
}

/** The takeover layer itself. Mount it (conditionally, when the param is set)
 *  inside `<main data-route-transition-page>` as a SIBLING of the routed
 *  content — same slot as `.plan-dash-takeover`. */
export function ReportTakeoverLayer({
  children,
  testId = "report-takeover",
  label = "Report review",
}: ReportTakeoverLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const parent = layer?.parentElement;
    if (!layer || !parent) return;

    const active = document.activeElement;
    const priorFocus =
      active instanceof HTMLElement && active !== document.body ? active : null;
    const parentState = takeoverParents.get(parent);
    if (parentState) parentState.count += 1;
    else takeoverParents.set(parent, { count: 1, restoreFocus: priorFocus });

    const children = Array.from(parent.children);
    const layerIndex = children.indexOf(layer);
    const siblings = children.filter(
      (node, index): node is HTMLElement =>
        node !== layer &&
        node instanceof HTMLElement &&
        // Equal-z takeover siblings later in DOM order paint above this one.
        // Leave those active; the later layer will isolate this lower layer.
        (!node.classList.contains("review-report-takeover") ||
          index < layerIndex),
    );
    // Move focus before hiding the prior pane so no focused descendant is ever
    // seated under aria-hidden/inert, even for the duration of one effect.
    layer.focus({ preventScroll: true });
    for (const sibling of siblings) isolateSibling(sibling);

    return () => {
      // React removes the focused subtree before passive-effect cleanup, so
      // browsers have already fallen back to <body> by the time this runs.
      // A real focus move to visible chrome remains a concrete non-body node
      // and must not be overwritten.
      const activeWasInside =
        layer.contains(document.activeElement) ||
        document.activeElement === document.body;
      for (const sibling of siblings) releaseSibling(sibling);

      const current = takeoverParents.get(parent);
      if (!current) return;
      current.count -= 1;
      if (current.count === 0) {
        takeoverParents.delete(parent);
        if (
          activeWasInside &&
          current.restoreFocus?.isConnected &&
          !current.restoreFocus.closest("[inert]")
        ) {
          current.restoreFocus.focus({ preventScroll: true });
        }
        return;
      }

      if (activeWasInside) {
        const remainingLayer = Array.from(
          parent.querySelectorAll<HTMLElement>(".review-report-takeover"),
        )
          .filter((node) => node !== layer && !node.hasAttribute("inert"))
          .at(-1);
        remainingLayer?.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div
      ref={layerRef}
      className="review-report-takeover"
      data-testid={testId}
      role="region"
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </div>
  );
}
