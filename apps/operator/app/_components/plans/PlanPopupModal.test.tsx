// @vitest-environment jsdom
import type { CSSProperties, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  NuqsTestingAdapter,
  type OnUrlUpdateFunction,
} from "nuqs/adapters/testing";
import type { AuthorIdentity } from "@/app/admin/plans/plans-api";

const { planRows, planListState, usePlanList } = vi.hoisted(() => ({
  planRows: {
    value: [] as Array<{
      slug: string;
      harness: string;
      origin?: "scout";
      ownerIdentity?: AuthorIdentity;
    }>,
  },
  planListState: {
    loading: false,
    error: null as Error | null,
  },
  usePlanList: vi.fn(),
}));

vi.mock("@/app/admin/plans/plans-api", () => ({
  usePlanList: (args: Record<string, unknown>) => {
    usePlanList(args);
    return {
      data: { plans: planRows.value },
      loading: planListState.loading,
      error: planListState.error,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("@/app/harness/Modal", () => ({
  Modal: ({
    open,
    children,
    contentClassName,
    contentStyle,
  }: {
    open: boolean;
    children: ReactNode;
    contentClassName?: string;
    contentStyle?: CSSProperties;
  }) =>
    open ? (
      <div
        data-testid="plan-popup-modal"
        className={contentClassName}
        style={contentStyle}
      >
        {children}
      </div>
    ) : null,
}));

vi.mock("@/app/harness/Tooltip", () => ({
  Tooltip: ({ label, children }: { label: ReactNode; children: ReactNode }) => (
    <span title={typeof label === "string" ? label : undefined}>
      {children}
    </span>
  ),
}));

vi.mock("@/app/admin/plans/PlanDetail", () => ({
  default: () => <div data-testid="plan-detail" />,
}));

vi.mock("@/app/harness/useConfirmDialog", () => ({
  useConfirmDialog: () => ({
    confirm: vi.fn().mockResolvedValue(true),
    element: null,
  }),
}));

vi.mock("./PlanSessionsTab", () => ({
  default: () => <div data-testid="plan-sessions" />,
}));

import PlanPopupModal, { isPopupSurfaceFullscreen } from "./PlanPopupModal";

afterEach(() => {
  planRows.value = [];
  planListState.loading = false;
  planListState.error = null;
  usePlanList.mockClear();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .requestFullscreen;
  delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  cleanup();
});

const renderPopup = (
  origin: "scout" | null | undefined,
  ownerIdentity?: AuthorIdentity | null,
  options?: {
    searchParams?: string;
    onUrlUpdate?: OnUrlUpdateFunction;
    onClose?: () => void;
  },
) =>
  render(
    <NuqsTestingAdapter
      searchParams={options?.searchParams ?? ""}
      onUrlUpdate={options?.onUrlUpdate}
    >
      <PlanPopupModal
        planSlug="provenance-plan"
        harnessSlug="papercusp"
        planTitle="Provenance plan"
        origin={origin}
        ownerIdentity={ownerIdentity}
        onClose={options?.onClose ?? (() => {})}
      />
    </NuqsTestingAdapter>,
  );

function installFullscreenApi(enabled = true) {
  let fullscreenElement: Element | null = null;
  const requestFullscreen = vi.fn(function request(this: HTMLElement) {
    fullscreenElement = this;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  const exitFullscreen = vi.fn(() => {
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
    configurable: true,
    value: enabled ? requestFullscreen : undefined,
  });
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    value: enabled,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    value: exitFullscreen,
  });
  return {
    requestFullscreen,
    exitFullscreen,
    externalExit: () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    },
  };
}

describe("PlanPopupModal provenance", () => {
  it.each([
    ["scout", undefined, "Blender", "blender", "Plan source: Blender"],
    [
      null,
      { id: "avi", handle: "Avi", kind: "human", verified: true },
      "Avi",
      "user",
      "Plan source: Avi (User)",
    ],
  ] as const)(
    "renders %s as %s in the popup header",
    (origin, ownerIdentity, label, dataValue, ariaLabel) => {
      renderPopup(origin, ownerIdentity);
      const badge = screen.getByTestId("plan-popup-provenance-badge");
      expect(badge.textContent).toBe(label);
      expect(badge.getAttribute("data-plan-provenance")).toBe(dataValue);
      expect(badge.getAttribute("aria-label")).toBe(ariaLabel);
    },
  );

  it("resolves an omitted origin from the canonical scoped plans.list row", () => {
    planRows.value = [
      {
        slug: "provenance-plan",
        harness: "papercusp",
        ownerIdentity: {
          id: "avi",
          handle: "Avi",
          kind: "human",
          verified: true,
        },
      },
      { slug: "provenance-plan", harness: "other" },
    ];

    renderPopup(undefined);

    const badge = screen.getByTestId("plan-popup-provenance-badge");
    expect(badge.textContent).toBe("Avi");
    expect(badge.getAttribute("data-plan-provenance")).toBe("user");
    expect(usePlanList).toHaveBeenCalledWith({
      includeArchived: true,
      includeLegacy: true,
      harness_slugs: ["papercusp"],
      enabled: true,
    });
  });

  it("resolves a missing owner identity even when User provenance is explicit", () => {
    planRows.value = [
      {
        slug: "provenance-plan",
        harness: "papercusp",
        ownerIdentity: {
          id: "avi",
          handle: "Avi",
          kind: "human",
          verified: true,
        },
      },
    ];

    renderPopup(null, undefined);

    const badge = screen.getByTestId("plan-popup-provenance-badge");
    expect(badge.textContent).toBe("Avi");
    expect(badge.getAttribute("aria-label")).toBe("Plan source: Avi (User)");
    expect(usePlanList).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it.each([
    ["loading", true, null],
    ["missing", false, null],
    ["error", false, new Error("plans.list failed")],
  ] as const)(
    "does not misclassify unresolved omitted provenance while the lookup is %s",
    (_state, loading, error) => {
      planListState.loading = loading;
      planListState.error = error;

      renderPopup(undefined);

      expect(screen.queryByTestId("plan-popup-provenance-badge")).toBeNull();
    },
  );

  it("does not borrow provenance from a same-slug row in the wrong harness", () => {
    planRows.value = [
      { slug: "provenance-plan", harness: "other", origin: "scout" },
    ];

    renderPopup(undefined);

    expect(screen.queryByTestId("plan-popup-provenance-badge")).toBeNull();
    expect(usePlanList).toHaveBeenCalledWith({
      includeArchived: true,
      includeLegacy: true,
      harness_slugs: ["papercusp"],
      enabled: true,
    });
  });
});

describe("PlanPopupModal fullscreen and target lifecycle", () => {
  it("does not mistake an unattached ref plus an idle Fullscreen API for fullscreen", () => {
    const surface = document.createElement("div");
    expect(isPopupSurfaceFullscreen(null, null)).toBe(false);
    expect(isPopupSurfaceFullscreen(null, surface)).toBe(false);
    expect(isPopupSurfaceFullscreen(surface, surface)).toBe(true);
  });

  it("fullscreenes the complete popup surface, restores it, and follows external exit", async () => {
    const fullscreen = installFullscreenApi();
    renderPopup(null, null);

    const surface = screen.getByTestId("plan-popup-fullscreen-surface");
    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    await waitFor(() =>
      expect(fullscreen.requestFullscreen).toHaveBeenCalledTimes(1),
    );
    expect(fullscreen.requestFullscreen.mock.instances[0]).toBe(surface);
    expect(
      screen.getByRole("button", { name: "Exit fullscreen" }),
    ).toBeTruthy();

    fullscreen.externalExit();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Enter fullscreen" }),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Exit fullscreen" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    await waitFor(() =>
      expect(fullscreen.exitFullscreen).toHaveBeenCalledTimes(1),
    );
  });

  it("disables fullscreen with an explanation when the API is unavailable", () => {
    installFullscreenApi(false);
    renderPopup(null, null);

    const button = screen.getByRole("button", {
      name: "Enter fullscreen",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // No native title on the button (design-primitives lint): the explanation
    // is the Tooltip primitive's label (the mock above renders it as a title on
    // its own span), reached through the focusable wrapper that stands in for
    // a disabled button, which receives no pointer/focus events of its own.
    expect(button.hasAttribute("title")).toBe(false);
    const wrap = screen.getByTestId("plan-popup-fullscreen-wrap");
    expect(wrap.tabIndex).toBe(0);
    expect(button.closest("[title]")?.getAttribute("title")).toContain(
      "Fullscreen is not available",
    );
  });

  it("clears stale popup view and P/D target state on close", async () => {
    const onUrlUpdate = vi.fn<OnUrlUpdateFunction>();
    const onClose = vi.fn();
    renderPopup(null, null, {
      searchParams: "?ppv=sessions&jump=D-004",
      onUrlUpdate,
      onClose,
    });

    fireEvent.click(screen.getByTestId("plan-popup-close"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const writes = onUrlUpdate.mock.calls.map((call) => call[0].queryString);
      expect(
        writes.some(
          (search) => !search.includes("ppv=") && !search.includes("jump="),
        ),
      ).toBe(true);
    });
  });
});
