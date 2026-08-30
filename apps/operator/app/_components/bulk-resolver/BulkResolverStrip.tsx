"use client";

/**
 * Generalized bulk-resolver command strip shared by Inbox resolve and Plans
 * clean-up. Consumers own run semantics and backend actions; this component
 * owns the idle/running/review visual grammar so the two tabs cannot drift.
 */
import type { ReactNode } from "react";
import { ChevronRight, Loader2, Sparkles, Square, X } from "lucide-react";
import "../inbox/inbox-bulk.css";

export type BulkResolverMetricTone = "good" | "review" | "muted";

export interface BulkResolverMetric {
  id: string;
  value: ReactNode;
  label: ReactNode;
  tone?: BulkResolverMetricTone;
}

export interface BulkResolverNotice {
  message: ReactNode;
  role?: "alert" | "status";
  testId?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}

interface BulkResolverStripBaseProps {
  settings: ReactNode;
  testId?: string;
  notice?: BulkResolverNotice | null;
}

export interface BulkResolverIdleStripProps extends BulkResolverStripBaseProps {
  state: "idle";
  actionTestId: string;
  ariaLabel: string;
  icon: ReactNode;
  busy: boolean;
  disabled: boolean;
  title: ReactNode;
  subtitle: ReactNode;
  onStart: () => void;
}

export interface BulkResolverRunningStripProps extends BulkResolverStripBaseProps {
  state: "running";
  title: ReactNode;
  stopTestId: string;
  stopDisabled?: boolean;
  onStop: () => void;
  progress: {
    percent?: number;
    width?: string;
    ariaLabel: string;
    ariaValueText?: string;
  };
  metrics: readonly BulkResolverMetric[];
  metricsTestId: string;
}

export interface BulkResolverReviewStripProps extends BulkResolverStripBaseProps {
  state: "review";
  icon?: ReactNode;
  headline: ReactNode;
  headlineTestId: string;
  elapsed?: string | null;
  metrics: readonly BulkResolverMetric[];
  metricsTestId: string;
  metricsAriaLabel: string;
  actions: ReactNode;
  hint: ReactNode;
}

export type BulkResolverStripProps =
  | BulkResolverIdleStripProps
  | BulkResolverRunningStripProps
  | BulkResolverReviewStripProps;

function MetricList({
  metrics,
  testId,
  ariaLabel,
  accounting = false,
}: {
  metrics: readonly BulkResolverMetric[];
  testId: string;
  ariaLabel?: string;
  accounting?: boolean;
}) {
  return (
    <div
      className={`op-inbox__bulk-counts${accounting ? " op-inbox__bulk-counts--accounting" : ""}`}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {metrics.map((metric) => (
        <span
          key={metric.id}
          className={`op-inbox__bulk-count op-inbox__bulk-count--${
            metric.tone === "good"
              ? "good"
              : metric.tone === "review"
                ? "review"
                : "left"
          }`}
        >
          <i aria-hidden="true" />
          {metric.value} {metric.label}
        </span>
      ))}
    </div>
  );
}

function Notice({ notice }: { notice: BulkResolverNotice }) {
  return (
    <div
      className="op-inbox__bulk-notice"
      role={notice.role ?? "alert"}
      data-testid={notice.testId}
    >
      <span>{notice.message}</span>
      {notice.onDismiss ? (
        <button
          type="button"
          className="op-inbox__bulk-notice-x"
          aria-label={notice.dismissLabel ?? "Dismiss message"}
          onClick={notice.onDismiss}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export default function BulkResolverStrip(props: BulkResolverStripProps) {
  if (props.state === "idle") {
    return (
      <div
        className="op-inbox__bulk-slot"
        data-testid={props.testId}
        data-bulk-resolver-strip-state="idle"
      >
        {props.settings}
        <button
          type="button"
          className="op-inbox__bulk-start"
          data-testid={props.actionTestId}
          disabled={props.disabled}
          aria-label={props.ariaLabel}
          onClick={props.onStart}
        >
          <span className="op-inbox__bulk-icon" aria-hidden="true">
            {props.busy ? (
              <span className="op-inbox__bulk-spin">
                <Loader2 size={17} />
              </span>
            ) : (
              props.icon
            )}
          </span>
          <span className="op-inbox__bulk-start-copy">
            <span className="op-inbox__bulk-start-title">{props.title}</span>
            <span className="op-inbox__bulk-start-sub">{props.subtitle}</span>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        {props.notice ? <Notice notice={props.notice} /> : null}
      </div>
    );
  }

  if (props.state === "running") {
    const progressWidth =
      props.progress.width ?? `${props.progress.percent ?? 0}%`;
    return (
      <div
        className="op-inbox__bulk op-inbox__bulk--running"
        data-testid={props.testId}
        data-bulk-resolver-strip-state="running"
      >
        {props.settings}
        <div className="op-inbox__bulk-head">
          <span className="op-inbox__bulk-spin" aria-hidden="true">
            <Loader2 size={15} />
          </span>
          <span className="op-inbox__bulk-title">{props.title}</span>
          <span className="op-inbox__bulk-spacer" />
          <button
            type="button"
            className="op-inbox__bulk-ghost"
            data-testid={props.stopTestId}
            disabled={props.stopDisabled}
            onClick={props.onStop}
          >
            <Square size={11} aria-hidden="true" />
            Stop
          </button>
        </div>
        <div
          className="op-inbox__bulk-track"
          role="progressbar"
          aria-valuenow={props.progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={props.progress.ariaValueText}
          aria-label={props.progress.ariaLabel}
        >
          <div
            className="op-inbox__bulk-fill"
            style={{ width: progressWidth }}
          />
        </div>
        <MetricList metrics={props.metrics} testId={props.metricsTestId} />
        {props.notice ? <Notice notice={props.notice} /> : null}
      </div>
    );
  }

  return (
    <div
      className="op-inbox__bulk op-inbox__bulk--review"
      data-testid={props.testId}
      data-bulk-resolver-strip-state="review"
    >
      {props.settings}
      <div className="op-inbox__bulk-head">
        <span
          className="op-inbox__bulk-icon op-inbox__bulk-icon--review"
          aria-hidden="true"
        >
          {props.icon ?? <Sparkles size={16} />}
        </span>
        <span
          className="op-inbox__bulk-title"
          data-testid={props.headlineTestId}
        >
          {props.headline}
        </span>
        <span className="op-inbox__bulk-spacer" />
        {props.elapsed ? (
          <span className="op-inbox__bulk-elapsed">run {props.elapsed}</span>
        ) : null}
      </div>
      <MetricList
        metrics={props.metrics}
        testId={props.metricsTestId}
        ariaLabel={props.metricsAriaLabel}
        accounting
      />
      <div className="op-inbox__bulk-actions">{props.actions}</div>
      <p className="op-inbox__bulk-hint">{props.hint}</p>
      {props.notice ? <Notice notice={props.notice} /> : null}
    </div>
  );
}
