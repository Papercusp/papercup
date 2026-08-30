// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BulkResolverStrip from "./BulkResolverStrip";

afterEach(cleanup);

describe("BulkResolverStrip", () => {
  it("owns the shared idle frame and its dismissible notice", () => {
    const onStart = vi.fn();
    const onDismiss = vi.fn();
    render(
      <BulkResolverStrip
        state="idle"
        testId="shared-idle"
        settings={<span>Resolver settings</span>}
        actionTestId="shared-start"
        ariaLabel="Start bulk work"
        icon={<span>✦</span>}
        busy={false}
        disabled={false}
        title="Start bulk work"
        subtitle="Review uncertain results"
        onStart={onStart}
        notice={{ message: "Start failed", onDismiss }}
      />,
    );

    expect(
      screen
        .getByTestId("shared-idle")
        .getAttribute("data-bulk-resolver-strip-state"),
    ).toBe("idle");
    fireEvent.click(screen.getByTestId("shared-start"));
    expect(onStart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Dismiss message"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the shared running progress and metric grammar", () => {
    const onStop = vi.fn();
    render(
      <BulkResolverStrip
        state="running"
        testId="shared-running"
        settings={<span>Fixed launch settings</span>}
        title="Papercup is resolving…"
        stopTestId="shared-stop"
        onStop={onStop}
        progress={{
          percent: 50,
          ariaLabel: "Bulk progress",
          ariaValueText: "2 of 4 decided",
        }}
        metrics={[
          { id: "done", value: 2, label: "resolved", tone: "good" },
          { id: "left", value: 2, label: "left" },
        ]}
        metricsTestId="shared-running-counts"
      />,
    );

    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("50");
    expect(progress.getAttribute("aria-valuetext")).toBe("2 of 4 decided");
    expect(screen.getByTestId("shared-running-counts").textContent).toContain(
      "2 resolved",
    );
    fireEvent.click(screen.getByTestId("shared-stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("renders the shared review frame with flow-specific action slots", () => {
    const onReview = vi.fn();
    render(
      <BulkResolverStrip
        state="review"
        testId="shared-review"
        settings={<span>Launch receipt</span>}
        headline="4 assessed · 2 still open"
        headlineTestId="shared-review-headline"
        elapsed="12s"
        metrics={[
          {
            id: "recommendations",
            value: 2,
            label: "recommendations",
            tone: "review",
          },
        ]}
        metricsTestId="shared-review-counts"
        metricsAriaLabel="Review accounting"
        actions={
          <button type="button" onClick={onReview}>
            Review unresolved
          </button>
        }
        hint="Every unresolved row keeps its proposed next step."
      />,
    );

    expect(
      screen
        .getByTestId("shared-review")
        .getAttribute("data-bulk-resolver-strip-state"),
    ).toBe("review");
    expect(screen.getByText("run 12s")).toBeTruthy();
    fireEvent.click(screen.getByText("Review unresolved"));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
