// @vitest-environment jsdom
//
// ReportTakeover (cleanup-report-flows-2026-08-24 P-001): the shared takeover
// wiring — useReportTakeoverParam is URL-driven (nuqs) with open/show/close,
// and ReportTakeoverLayer renders the takeover chrome. Mirrors the
// PlanDashboardHost.test.tsx nuqs-mock conventions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { nuqs, setters } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
function mkSetter(key: string) {
  if (!setters[key])
    setters[key] = vi.fn(async (v: unknown) => {
      nuqs[key] = v;
    });
  return setters[key];
}

import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
    mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));

import { ReportTakeoverLayer, useReportTakeoverParam } from "./ReportTakeover";

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
});

function Probe({ paramKey }: { paramKey: string }) {
  const p = useReportTakeoverParam(paramKey);
  return (
    <div data-testid="probe" data-open={p.open} data-value={p.value ?? ""}>
      <button
        type="button"
        data-testid="probe-show"
        onClick={() => p.show("run-7")}
      >
        show
      </button>
      <button type="button" data-testid="probe-close" onClick={p.close}>
        close
      </button>
    </div>
  );
}

describe("useReportTakeoverParam", () => {
  it("is closed with no param, opens via show(value), and close() clears the param", () => {
    render(<Probe paramKey="opcln" />);
    expect(screen.getByTestId("probe").dataset.open).toBe("false");

    fireEvent.click(screen.getByTestId("probe-show"));
    expect(setters["opcln"]).toHaveBeenCalledWith("run-7");

    nuqs["opcln"] = "run-7";
    cleanup();
    render(<Probe paramKey="opcln" />);
    const probe = screen.getByTestId("probe");
    expect(probe.dataset.open).toBe("true");
    expect(probe.dataset.value).toBe("run-7");

    fireEvent.click(screen.getByTestId("probe-close"));
    expect(setters["opcln"]).toHaveBeenLastCalledWith(null);
  });

  it("keys are independent — one renderer per param, as with pdash/pplan", () => {
    nuqs["opcln"] = "run-7";
    render(<Probe paramKey="inbox-review" />);
    expect(screen.getByTestId("probe").dataset.open).toBe("false");
  });
});

describe("ReportTakeoverLayer", () => {
  it("renders the takeover chrome around its children with the default testid", () => {
    render(
      <ReportTakeoverLayer>
        <span data-testid="payload">report body</span>
      </ReportTakeoverLayer>,
    );
    const layer = screen.getByTestId("report-takeover");
    expect(layer.className).toBe("review-report-takeover");
    expect(layer.getAttribute("role")).toBe("region");
    expect(layer.getAttribute("aria-label")).toBe("Report review");
    expect(screen.getByTestId("payload").textContent).toBe("report body");
  });

  it("honors a custom testid so two takeovers can coexist in one DOM", () => {
    render(
      <ReportTakeoverLayer testId="cleanup-report-takeover">
        <span>x</span>
      </ReportTakeoverLayer>,
    );
    expect(screen.getByTestId("cleanup-report-takeover")).toBeTruthy();
  });

  it("isolates the covered route, focuses the report, and restores both on close", () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <main>
          <section data-testid="route-content">
            <button type="button" data-testid="route-opener">
              open report
            </button>
          </section>
          {open ? (
            <ReportTakeoverLayer label="Plan clean-up report">
              <button type="button">Apply selected</button>
            </ReportTakeoverLayer>
          ) : null}
        </main>
      );
    }

    const { rerender } = render(<Harness open={false} />);
    const route = screen.getByTestId("route-content");
    const opener = screen.getByTestId("route-opener");
    opener.focus();

    rerender(<Harness open />);
    const layer = screen.getByRole("region", { name: "Plan clean-up report" });
    expect(route.hasAttribute("inert")).toBe(true);
    expect(route.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(layer);

    rerender(<Harness open={false} />);
    expect(route.hasAttribute("inert")).toBe(false);
    expect(route.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the route isolated until the final stacked report closes", () => {
    function Harness({ layers }: { layers: string[] }) {
      return (
        <main>
          <section data-testid="stacked-route">
            <button type="button" data-testid="stacked-opener">
              open reports
            </button>
          </section>
          {layers.map((label) => (
            <ReportTakeoverLayer
              key={label}
              label={label}
              testId={`layer-${label}`}
            >
              <button type="button">{label}</button>
            </ReportTakeoverLayer>
          ))}
        </main>
      );
    }

    const { rerender } = render(<Harness layers={[]} />);
    const route = screen.getByTestId("stacked-route");
    const opener = screen.getByTestId("stacked-opener");
    opener.focus();

    rerender(<Harness layers={["plans", "inbox"]} />);
    expect(route.hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("layer-plans").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("layer-inbox").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId("layer-inbox"));

    rerender(<Harness layers={["plans"]} />);
    expect(route.hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("layer-plans").hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId("layer-plans"));

    rerender(<Harness layers={[]} />);
    expect(route.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});
