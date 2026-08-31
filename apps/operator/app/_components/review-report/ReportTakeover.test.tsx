// @vitest-environment jsdom
//
// ReportTakeover (cleanup-report-flows-2026-08-24 P-001): the shared takeover
// wiring — useReportTakeoverParam is URL-driven (nuqs) with open/show/close,
// and ReportTakeoverLayer renders the takeover chrome. Mirrors the
// PlanDashboardHost.test.tsx nuqs-mock conventions.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

const { nuqs, setQueryStates } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setQueryStates: vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(nuqs, patch);
  }),
}));
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryStates: (parsers: Record<string, { _d?: unknown }>) => [
    Object.fromEntries(
      Object.entries(parsers).map(([key, parser]) => [
        key,
        nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
      ]),
    ),
    setQueryStates,
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));

import {
  REPORT_TAKEOVER_OWNER_PARAM,
  ReportTakeoverLayer,
  useReleaseMissingReportTakeover,
  useReportTakeoverParam,
  type ReportTakeoverParamKey,
} from "./ReportTakeover";

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  setQueryStates.mockClear();
  toastInfo.mockClear();
});

function Probe({
  paramKey,
  testId = "probe",
}: {
  paramKey: ReportTakeoverParamKey;
  testId?: string;
}) {
  const p = useReportTakeoverParam(paramKey);
  return (
    <div
      data-testid={testId}
      data-open={p.open}
      data-foreground={p.foreground}
      data-value={p.value ?? ""}
    >
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

function AvailabilityProbe({
  paramKey,
  enabled = true,
  loading = false,
  available = false,
}: {
  paramKey: ReportTakeoverParamKey;
  enabled?: boolean;
  loading?: boolean;
  available?: boolean;
}) {
  const report = useReportTakeoverParam(paramKey);
  useReleaseMissingReportTakeover(report, { enabled, loading, available });
  return null;
}

describe("useReportTakeoverParam", () => {
  it("is closed with no param, opens via show(value), and close() clears the param", () => {
    render(<Probe paramKey="opcln" />);
    expect(screen.getByTestId("probe").dataset.open).toBe("false");

    fireEvent.click(screen.getByTestId("probe-show"));
    expect(setQueryStates).toHaveBeenCalledWith({
      opcln: "run-7",
      [REPORT_TAKEOVER_OWNER_PARAM]: "opcln",
    });

    nuqs["opcln"] = "run-7";
    cleanup();
    render(<Probe paramKey="opcln" />);
    const probe = screen.getByTestId("probe");
    expect(probe.dataset.open).toBe("true");
    expect(probe.dataset.foreground).toBe("true");
    expect(probe.dataset.value).toBe("run-7");

    fireEvent.click(screen.getByTestId("probe-close"));
    expect(setQueryStates).toHaveBeenLastCalledWith({
      opcln: null,
      [REPORT_TAKEOVER_OWNER_PARAM]: null,
    });
  });

  it("returns the nuqs URL-update promise from show and close", () => {
    const { result } = renderHook(() => useReportTakeoverParam("opcln"));

    const showPromise = result.current.show("run-7");
    expect(showPromise).toBe(setQueryStates.mock.results[0]?.value);

    nuqs.opcln = "run-7";
    const closePromise = result.current.close();
    expect(closePromise).toBe(setQueryStates.mock.results[1]?.value);
  });

  it("keys are independent — one renderer per param, as with pdash/pplan", () => {
    nuqs["opcln"] = "run-7";
    render(<Probe paramKey="opcbr" />);
    expect(screen.getByTestId("probe").dataset.open).toBe("false");
    expect(screen.getByTestId("probe").dataset.foreground).toBe("false");
  });

  it("uses deterministic legacy priority when both pre-marker params remain", () => {
    nuqs.opcln = "run-7";
    nuqs.opcbr = "run-8";
    render(
      <>
        <Probe paramKey="opcln" testId="plans-probe" />
        <Probe paramKey="opcbr" testId="inbox-probe" />
      </>,
    );

    expect(screen.getByTestId("plans-probe").dataset.foreground).toBe("false");
    expect(screen.getByTestId("inbox-probe").dataset.foreground).toBe("true");
  });

  it("honors a valid owner marker and falls back when the marker is stale", () => {
    nuqs.opcln = "run-7";
    nuqs.opcbr = "run-8";
    nuqs[REPORT_TAKEOVER_OWNER_PARAM] = "opcln";
    const { rerender } = render(<Probe paramKey="opcln" />);
    expect(screen.getByTestId("probe").dataset.foreground).toBe("true");

    nuqs[REPORT_TAKEOVER_OWNER_PARAM] = "missing-owner";
    rerender(<Probe paramKey="opcln" />);
    expect(screen.getByTestId("probe").dataset.foreground).toBe("false");
  });

  it("atomically hands foreground back to the remaining report on close", () => {
    nuqs.opcln = "run-7";
    nuqs.opcbr = "run-8";
    nuqs[REPORT_TAKEOVER_OWNER_PARAM] = "opcln";
    render(<Probe paramKey="opcln" />);

    fireEvent.click(screen.getByTestId("probe-close"));
    expect(setQueryStates).toHaveBeenLastCalledWith({
      opcln: null,
      [REPORT_TAKEOVER_OWNER_PARAM]: "opcbr",
    });
  });

  it("releases a settled missing owner to the ready sibling exactly once", async () => {
    nuqs.opcln = "missing-run";
    nuqs.opcbr = "ready-run";
    nuqs[REPORT_TAKEOVER_OWNER_PARAM] = "opcln";
    setQueryStates.mockImplementationOnce(async () => undefined);

    const { rerender } = render(<AvailabilityProbe paramKey="opcln" />);
    await waitFor(() =>
      expect(setQueryStates).toHaveBeenCalledWith({
        opcln: null,
        [REPORT_TAKEOVER_OWNER_PARAM]: "opcbr",
      }),
    );
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringMatching(/no longer exists.*cleared/i),
    );

    rerender(<AvailabilityProbe paramKey="opcln" />);
    expect(setQueryStates).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps ownership while the run is loading, available, or backgrounded", () => {
    nuqs.opcln = "run-7";
    nuqs.opcbr = "run-8";
    nuqs[REPORT_TAKEOVER_OWNER_PARAM] = "opcln";

    const { rerender } = render(<AvailabilityProbe paramKey="opcln" loading />);
    expect(setQueryStates).not.toHaveBeenCalled();

    rerender(<AvailabilityProbe paramKey="opcln" available />);
    expect(setQueryStates).not.toHaveBeenCalled();

    rerender(<AvailabilityProbe paramKey="opcbr" />);
    expect(setQueryStates).not.toHaveBeenCalled();
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

  it("isolates routed content that mounts after the takeover", async () => {
    function Harness({
      open,
      routeMounted,
    }: {
      open: boolean;
      routeMounted: boolean;
    }) {
      return (
        <main>
          {open ? (
            <ReportTakeoverLayer>
              <button type="button">Apply selected</button>
            </ReportTakeoverLayer>
          ) : null}
          {routeMounted ? (
            <section data-testid="late-route-content">
              <button type="button">Routed action</button>
            </section>
          ) : null}
        </main>
      );
    }

    const { rerender } = render(<Harness open routeMounted={false} />);
    expect(document.activeElement).toBe(screen.getByTestId("report-takeover"));

    rerender(<Harness open routeMounted />);
    const route = screen.getByTestId("late-route-content");
    await waitFor(() => {
      expect(route.hasAttribute("inert")).toBe(true);
      expect(route.getAttribute("aria-hidden")).toBe("true");
    });

    rerender(<Harness open={false} routeMounted />);
    expect(route.hasAttribute("inert")).toBe(false);
    expect(route.hasAttribute("aria-hidden")).toBe(false);
  });

  it("falls back to the app-pane landmark when completion removes the opener", () => {
    function Harness({
      open,
      showOpener,
    }: {
      open: boolean;
      showOpener: boolean;
    }) {
      return (
        <main data-route-transition-page="true" tabIndex={-1}>
          <section data-testid="completed-route">
            {showOpener ? (
              <button type="button" data-testid="completed-opener">
                Review decisions
              </button>
            ) : (
              <span>Run complete</span>
            )}
          </section>
          {open ? (
            <ReportTakeoverLayer>
              <button type="button">Apply selected</button>
            </ReportTakeoverLayer>
          ) : null}
        </main>
      );
    }

    const { rerender } = render(<Harness open={false} showOpener />);
    screen.getByTestId("completed-opener").focus();

    rerender(<Harness open showOpener />);
    expect(document.activeElement).toBe(screen.getByTestId("report-takeover"));

    // Apply/Dismiss/final inline accept advances the underlying strip out of
    // review before the URL-owned layer finishes unmounting.
    rerender(<Harness open showOpener={false} />);
    rerender(<Harness open={false} showOpener={false} />);

    expect(document.activeElement).toBe(
      screen.getByTestId("completed-route").parentElement,
    );
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
