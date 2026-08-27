// @vitest-environment jsdom
/**
 * Regression for the dashboard/global `wppop` path from WI-42397.
 *
 * This deliberately starts at the scoped URL value and renders the REAL
 * PlanPopupModal. ChatRefPopupHost's unit suite mocks that modal because it
 * tests singleton/scoping mechanics; that mock could not catch the production
 * bug where the global host omitted provenance and the modal rendered a Scout
 * plan as Outside Blender.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";

const { nuqs, nuqsSetters, planListArgs } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
  planListArgs: [] as Array<Record<string, unknown>>,
}));

function nuqsSetter(key: string) {
  if (!nuqsSetters[key]) {
    nuqsSetters[key] = vi.fn(async (value: unknown) => {
      nuqs[key] = value;
    });
  }
  return nuqsSetters[key];
}

vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
    nuqsSetter(key),
  ],
  parseAsString: { withDefault: (value: unknown) => ({ _d: value }) },
}));

vi.mock("@/app/adv/create/use-create-data", () => ({
  useResolvedHarnessSlug: () => null,
}));

vi.mock("@papercusp/operator-core/lib/lazy-with-retry", () => ({
  lazyWithRetry: (loader: () => Promise<{ default: unknown }>) => {
    let Component: any = null;
    void loader().then((module) => {
      Component = module.default;
    });
    return (props: Record<string, unknown>) =>
      Component ? <Component {...props} /> : null;
  },
}));

vi.mock("@/app/admin/plans/plans-api", () => ({
  usePlanList: (args: Record<string, unknown>) => {
    planListArgs.push(args);
    return {
      data: {
        plans: [
          {
            slug: "scout-plan",
            harness: "papercusp",
            origin: "scout",
          },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("@/app/harness/Modal", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="plan-popup-modal">{children}</div> : null,
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

vi.mock("../plans/PlanSessionsTab", () => ({
  default: () => <div data-testid="plan-sessions" />,
}));

vi.mock("../work-items/WorkItemPopupModal", () => ({
  default: () => null,
}));

import ChatRefPopupHost from "./ChatRefPopupHost";

afterEach(() => {
  for (const key of Object.keys(nuqs)) delete nuqs[key];
  for (const key of Object.keys(nuqsSetters)) delete nuqsSetters[key];
  planListArgs.length = 0;
  cleanup();
});

describe("ChatRefPopupHost plan provenance", () => {
  it("renders Blender from a scoped Scout wppop through the real plan modal", async () => {
    nuqs.wppop = "papercusp::scout-plan";
    const view = render(<ChatRefPopupHost />);

    await vi.waitFor(() => {
      view.rerender(<ChatRefPopupHost />);
      expect(screen.getByTestId("plan-popup-provenance-badge")).toBeTruthy();
    });

    const badge = screen.getByTestId("plan-popup-provenance-badge");
    expect(badge.textContent).toBe("Blender");
    expect(badge.getAttribute("data-plan-provenance")).toBe("blender");
    expect(planListArgs).toContainEqual({
      includeArchived: true,
      includeLegacy: true,
      harness_slugs: ["papercusp"],
      enabled: true,
    });
  });
});
