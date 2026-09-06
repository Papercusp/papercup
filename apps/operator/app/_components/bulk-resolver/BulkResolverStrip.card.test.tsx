/**
 * BulkResolverStrip `variant="card"` — the compact form for the split Inbox
 * page's 210px rail (inbox-three-column-resolver-states-2026-09-06 P-003).
 * Same three states, same test ids, same handlers as the band; what changes is
 * the frame: copy as text + a labelled button (idle), Stop under the counts
 * with a caption (running), an eyebrow and an optional hint (review).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BulkResolverStrip from "./BulkResolverStrip";

afterEach(cleanup);

describe("BulkResolverStrip variant=card", () => {
  it("idle: copy is text, the button carries its own label, and the variant is stamped", () => {
    const onStart = vi.fn();
    render(
      <BulkResolverStrip
        state="idle"
        variant="card"
        testId="card-idle"
        settings={<span data-testid="card-settings">settings</span>}
        actionTestId="card-start"
        ariaLabel="Review bulk recommendation for 3 filtered items"
        icon={<span>icon</span>}
        busy={false}
        disabled={false}
        eyebrow="Bulk resolve"
        title="3 rows can be reviewed together"
        subtitle="nothing applies without your gesture"
        actionLabel="Review bulk recommendation"
        onStart={onStart}
      />,
    );
    const slot = screen.getByTestId("card-idle");
    expect(slot.getAttribute("data-bulk-resolver-strip-state")).toBe("idle");
    expect(slot.getAttribute("data-bulk-resolver-strip-variant")).toBe("card");
    expect(slot.className).toContain("op-inbox__bulk-slot--card");
    expect(slot.querySelector(".op-inbox__bulk-card-hd")?.textContent).toContain(
      "Bulk resolve",
    );
    const start = screen.getByTestId("card-start");
    // The title is NOT inside the button in the card; the label is.
    expect(start.textContent).toContain("Review bulk recommendation");
    expect(start.textContent).not.toContain("3 rows can be reviewed together");
    expect(slot.textContent).toContain("3 rows can be reviewed together");
    expect(start.className).toContain("op-inbox__bulk-start--card");
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("running: Stop moves UNDER the counts and the caption renders", () => {
    const onStop = vi.fn();
    render(
      <BulkResolverStrip
        state="running"
        variant="card"
        testId="card-running"
        settings={null}
        title="Resolving…"
        stopTestId="card-stop"
        onStop={onStop}
        progress={{ percent: 62, ariaLabel: "98 of 158 decided" }}
        caption={<span data-testid="card-caption">98 of 158 decided</span>}
        metrics={[
          { id: "resolved", value: 84, label: "resolved", tone: "good" },
          { id: "review", value: 14, label: "review", tone: "review" },
          { id: "left", value: 60, label: "left" },
        ]}
        metricsTestId="card-counts"
      />,
    );
    const root = screen.getByTestId("card-running");
    expect(root.className).toContain("op-inbox__bulk--card");
    expect(root.getAttribute("data-bulk-resolver-strip-variant")).toBe("card");
    const stop = screen.getByTestId("card-stop");
    expect(stop.className).toContain("op-inbox__bulk-stop--card");
    // Head does not hold Stop; the counts come BEFORE it in document order.
    expect(root.querySelector(".op-inbox__bulk-head")?.contains(stop)).toBe(
      false,
    );
    const counts = screen.getByTestId("card-counts");
    expect(
      counts.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("card-caption").textContent).toBe(
      "98 of 158 decided",
    );
    expect(counts.textContent).toContain("14 review");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("review: the eyebrow renders, the hint is optional, and the actions slot is intact", () => {
    render(
      <BulkResolverStrip
        state="review"
        variant="card"
        testId="card-review"
        settings={null}
        eyebrow="Review ready"
        headline="143 unresolved · 6 retryable"
        headlineTestId="card-headline"
        elapsed="2m 10s"
        metrics={[
          { id: "recommendations", value: 120, label: "recommendations", tone: "review" },
        ]}
        metricsTestId="card-accounting"
        metricsAriaLabel="accounting"
        actions={<button type="button" data-testid="card-review-action">Review 143</button>}
      />,
    );
    const root = screen.getByTestId("card-review");
    expect(root.className).toContain("op-inbox__bulk--card");
    expect(root.querySelector(".op-inbox__bulk-card-hd")?.textContent).toContain(
      "Review ready",
    );
    expect(screen.getByTestId("card-headline").textContent).toBe(
      "143 unresolved · 6 retryable",
    );
    expect(root.querySelector(".op-inbox__bulk-hint")).toBeNull();
    expect(root.querySelector(".op-inbox__bulk-elapsed")?.textContent).toBe(
      "run 2m 10s",
    );
    expect(screen.getByTestId("card-review-action")).toBeTruthy();
  });

  it("strip (default) is untouched: no card classes, no variant stamp change", () => {
    render(
      <BulkResolverStrip
        state="idle"
        testId="band-idle"
        settings={null}
        actionTestId="band-start"
        ariaLabel="Bulk resolve 2 filtered items"
        icon={<span>icon</span>}
        busy={false}
        disabled={false}
        title="Bulk resolve 2 filtered items"
        subtitle="the rest come back pre-recommended"
        onStart={() => {}}
      />,
    );
    const slot = screen.getByTestId("band-idle");
    expect(slot.className).toBe("op-inbox__bulk-slot");
    expect(slot.getAttribute("data-bulk-resolver-strip-variant")).toBe("strip");
    expect(slot.querySelector(".op-inbox__bulk-card-hd")).toBeNull();
    // In the band the title lives INSIDE the button.
    expect(screen.getByTestId("band-start").textContent).toContain(
      "Bulk resolve 2 filtered items",
    );
  });
});
