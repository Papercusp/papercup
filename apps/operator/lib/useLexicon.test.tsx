/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("./flag-hooks", () => ({ useFlag: () => false }));

import { HarnessLexiconProvider, useLexicon } from "./useLexicon";

const fetchMock = vi.fn<typeof fetch>();

function response(lexicon: Record<string, string>): Response {
  return new Response(JSON.stringify({ identity: { lexicon } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function Reader() {
  const t = useLexicon();
  return (
    <output data-testid="terms">
      {t("workUnit")}|{t("workUnit", { plural: true })}|
      {t("workUnit", { lower: true })}|{t("reviewGate")}
    </output>
  );
}

function Subject({ slug }: { slug: string }) {
  return (
    <HarnessLexiconProvider harnessSlug={slug}>
      <Reader />
    </HarnessLexiconProvider>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HarnessLexiconProvider", () => {
  it("starts from built-in domain fallbacks, then overlays the exact harness blueprint terms", async () => {
    fetchMock.mockResolvedValue(
      response({ workUnit: "deliverable", reviewGate: "approval" }),
    );
    render(<Subject slug="work/member" />);

    expect(screen.getByTestId("terms").textContent).toBe(
      "Work item|Work items|work item|Review gate",
    );
    await waitFor(() => {
      expect(screen.getByTestId("terms").textContent).toBe(
        "Deliverable|Deliverables|deliverable|Approval",
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/harness/work%2Fmember/blueprint-params",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("drops the previous slug synchronously and ignores its late response", async () => {
    let resolveAlpha: (value: Response) => void = () => {};
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveAlpha = resolve;
        }),
      )
      .mockResolvedValueOnce(response({ workUnit: "report" }));

    const view = render(<Subject slug="alpha" />);
    expect(screen.getByTestId("terms").textContent).toContain("Work item");

    view.rerender(<Subject slug="beta" />);
    expect(screen.getByTestId("terms").textContent).toContain("Work item");
    await waitFor(() =>
      expect(screen.getByTestId("terms").textContent).toContain(
        "Report|Reports",
      ),
    );

    await act(async () => {
      resolveAlpha(response({ workUnit: "deliverable" }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("terms").textContent).toContain("Report|Reports");
    expect(screen.getByTestId("terms").textContent).not.toContain(
      "Deliverable",
    );
  });
});
