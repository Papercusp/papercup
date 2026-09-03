// @vitest-environment jsdom
//
// KnowledgePackCandidates render + decide coverage (consume-edges P-032 / B-11;
// auto-adopt reversal WI-5414). The fleet→pack strip: pending candidates with
// provenance, the draft expander, the "adopt now"/"dismiss now" manual-override
// buttons POSTing through /api/knowledge-packs/candidate-decide (adopt surfaces
// the "pack updated" hint; failures surface role=alert), the recently-auto-adopted
// strip, and the empty-everything case rendering nothing. useSyncQuery + nuqs
// mocked, the pinned sibling pattern (LearningTab.test.tsx).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { KnowledgePackCandidate } from "@papercusp/operator-core/lib/knowledge-packs/candidates";

const nuqsState: Record<string, unknown> = { lcand: "" };
const setLcand = vi.fn();
import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [nuqsState[key], setLcand],
  parseAsString: { withDefault: () => ({}) },
}));

const invalidate = vi.fn();
const recentInvalidate = vi.fn();
let candidates: KnowledgePackCandidate[] = [];
let recentAdopted: KnowledgePackCandidate[] = [];
// The component fires TWO useSyncQuery calls with the same queryName but
// different `args` (pending queue vs. the recent-auto-adoptions strip) — the
// mock discriminates on args.status so each returns its own fixture.
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { args?: { status?: string } }) =>
    opts.args?.status === "adopted"
      ? { data: recentAdopted, invalidate: recentInvalidate }
      : { data: candidates, invalidate },
}));
// Lexicon resolver mocked to ECHO its key (t('pot') → 'pot') — isolates the
// hives→pot routed tooltip from the THE_HIVE flag hook (restore-pot-lexicon P-006).
vi.mock("@/lib/useLexicon", () => ({ useLexicon: () => (k: string) => k }));

const { default: KnowledgePackCandidates } =
  await import("./KnowledgePackCandidates");

const cand = (
  over: Partial<KnowledgePackCandidate> = {},
): KnowledgePackCandidate => ({
  id: "cand-1",
  signature: "lock edit serialize",
  title: "Coordinate shared-tree edits",
  draftText:
    "Find how this project serializes concurrent edits before writing.",
  kind: "feedback",
  appliesTo: ["any"],
  scopes: ["operator", "harness:sheets"],
  recurrenceCount: 4,
  sourceItemIds: ["EI-1", "EI-2"],
  status: "pending",
  createdBy: "recurrence-escalation",
  createdAt: new Date(0).toISOString(),
  ...over,
});

beforeEach(() => {
  nuqsState.lcand = "";
  candidates = [cand()];
  recentAdopted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("<KnowledgePackCandidates />", () => {
  it("renders nothing when there is nothing pending or recently auto-adopted", () => {
    candidates = [];
    recentAdopted = [];
    const { container } = render(<KnowledgePackCandidates />);
    expect(container.firstChild).toBeNull();
  });

  it("renders pending candidates with provenance; ?lcand expands the draft", () => {
    render(<KnowledgePackCandidates />);
    expect(screen.getByText("Coordinate shared-tree edits")).toBeTruthy();
    expect(screen.getByText("4× · 2 scopes").getAttribute("title")).toBe(
      "Recurred 4× across operator, harness:sheets · from EI-1, EI-2",
    );
    // Draft hidden until the row is selected via the URL param.
    expect(screen.queryByText(/serializes concurrent edits/)).toBeNull();

    cleanup();
    nuqsState.lcand = "cand-1";
    render(<KnowledgePackCandidates />);
    expect(screen.getByText(/serializes concurrent edits/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "hide draft" })).toBeTruthy();
  });

  it("copy no longer claims owner review — describes the automated sweep instead", () => {
    render(<KnowledgePackCandidates />);
    expect(
      screen.getByLabelText("Fleet lesson candidates — auto-reviewed and auto-adopted"),
    ).toBeTruthy();
    expect(screen.queryByText(/awaiting owner review/i)).toBeNull();
    expect(screen.getByText(/Auto-reviewed on a schedule/)).toBeTruthy();
  });

  // WI-5416 (owner ask): the head reads as an unlabeled list without a
  // provenance line — always shown once the block renders, not gated on
  // pending.length like the "how it's reviewed" sub-line above it.
  it("always states where candidates come from, even with nothing pending", () => {
    candidates = [];
    recentAdopted = [cand({ status: "adopted" })];
    render(<KnowledgePackCandidates />);
    expect(
      screen.getByText(
        "Cross-hive recurring lessons staged by the recurrence-escalation sweep.",
      ),
    ).toBeTruthy();
  });

  it("shows the highest-priority candidates first and progressively discloses the rest", () => {
    candidates = Array.from({ length: 5 }, (_, i) =>
      cand({ id: `cand-${i + 1}`, title: `Candidate ${i + 1}` }),
    );
    render(<KnowledgePackCandidates />);
    expect(screen.getByText("Candidate 3")).toBeTruthy();
    expect(screen.queryByText("Candidate 4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More candidates/ }));
    expect(screen.getByText("Candidate 4")).toBeTruthy();
    expect(screen.getByText("Candidate 5")).toBeTruthy();
  });

  it("renders the recently-auto-adopted strip even with an empty pending queue", () => {
    candidates = [];
    recentAdopted = [
      cand({
        id: "cand-auto-1",
        title: "Lock before you edit a shared file",
        status: "adopted",
        decidedBy: "fleet-candidate-auto-review",
      }),
    ];
    render(<KnowledgePackCandidates />);
    expect(screen.getByText("Lock before you edit a shared file")).toBeTruthy();
    expect(screen.getByText("Recently auto-adopted")).toBeTruthy();
    expect(screen.getByText(/Nothing awaiting review right now/)).toBeTruthy();
  });

  it("adopt now POSTs the decide route and surfaces the pack-updated hint", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          action: "adopt",
          packId: "fleet-lessons",
          packVersion: "0.0.3",
        }),
        {
          status: 200,
        },
      ),
    );
    render(<KnowledgePackCandidates />);
    fireEvent.click(screen.getByRole("button", { name: "adopt now" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Adopted into fleet-lessons v0\.0\.3/),
      ).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge-packs/candidate-decide",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "cand-1", action: "adopt" }),
      }),
    );
    expect(invalidate).toHaveBeenCalled();
    expect(recentInvalidate).toHaveBeenCalled();
  });

  it("dismiss now POSTs the decide route; a failed decide surfaces role=alert", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<KnowledgePackCandidates />);
    fireEvent.click(screen.getByRole("button", { name: "dismiss now" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge-packs/candidate-decide",
      expect.objectContaining({
        body: JSON.stringify({ id: "cand-1", action: "dismiss" }),
      }),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, reason: "not_pending" }), {
        status: 409,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "adopt now" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("not_pending"),
    );
  });
});
