// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import TriggersClient from "./TriggersClient";

const useFlag = vi.fn(() => true);
vi.mock("@/lib/flag-hooks", () => ({ useFlag: () => useFlag() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BINDING_ID = "10000000-0000-4000-8000-000000000001";
const payload = {
  enabled: true,
  counts: { sources: 1, bindings: 1, armed: 0, recentFailures: 1 },
  sources: [
    {
      id: "20000000-0000-4000-8000-000000000001",
      kind: "gmail",
      status: "connected",
      config: {},
      credentialRef: "google-oauth:fixture",
      cursor: {},
      lastConnectedAt: "2026-08-22T00:00:00.000Z",
      lastError: null,
      bindingCount: 1,
      armedBindingCount: 0,
      failedDeliveries24h: 1,
    },
  ],
  bindings: [
    {
      id: BINDING_ID,
      sourceId: "20000000-0000-4000-8000-000000000001",
      sourceKind: "gmail",
      sourceStatus: "connected",
      planHarnessSlug: "papercusp",
      planSlug: "triage-mail",
      eventPattern: "ext:gmail:message.*",
      eventFilter: { label: "support" },
      action: { type: "launch-plan" },
      armed: false,
      stormPolicy: { maxRuns: 2, windowSeconds: 60 },
      createdBy: "owner",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      lastRun: null,
    },
  ],
  recentRuns: [],
};

beforeEach(() => {
  useFlag.mockReturnValue(true);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return new Response(JSON.stringify({ ok: true, binding: {} }), {
          status: 200,
        });
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderClient(searchParams = "?view=bindings") {
  return render(<TriggersClient />, {
    wrapper: withNuqsTestingAdapter({ searchParams }),
  });
}

describe("/admin/triggers client", () => {
  it("renders the URL-selected bindings view from the shared snapshot", async () => {
    renderClient();
    expect(await screen.findByText("ext:gmail:message.*")).toBeTruthy();
    expect(screen.getByText("→ papercusp/triage-mail")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Arm ext:gmail:message.*" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("requires a human confirm and sends the server confirmation sentinel", async () => {
    renderClient();
    const toggle = await screen.findByRole("switch", {
      name: "Arm ext:gmail:message.*",
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(([, init]) => init?.method === "PATCH");
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
        op: "set-armed",
        id: BINDING_ID,
        armed: true,
        confirm: true,
      });
    });
  });

  it("deep-links to the sources view through nuqs state", async () => {
    renderClient("?view=sources");
    expect(await screen.findByText("google-oauth:fixture")).toBeTruthy();
    expect(screen.getByText("1 binding · 0 armed")).toBeTruthy();
  });

  it("renders the flag-off kill-switch without fetching data", () => {
    useFlag.mockReturnValue(false);
    renderClient();
    expect(
      screen.getByText("External trigger administration is switched off."),
    ).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
