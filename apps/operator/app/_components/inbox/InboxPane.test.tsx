// @vitest-environment jsdom
/**
 * InboxPane coverage (EI-13037; moved into the op-chat sidebar per the owner's
 * placement correction 2026-07-16). Pins:
 *   - the tier filter (default "Needs you" = decision tier, incl. the Brief 21
 *     wire-lag fallback for rows arriving without `tier`), chip counts;
 *   - row rendering (kind label, owner/plan meta) + selection (?opcis) that
 *     expands the Queue's OtherDetail inline (remount-per-selection key);
 *   - the empty ("inbox zero") state;
 *   - the "Open full queue" jump (?tab=plans&view=queue merge on /adv);
 *   - Discuss → writes the scoped work-item target and mounts the durable
 *     Papercup thread beneath the expanded row without touching global chat;
 *   - useInboxPendingCount / effectiveTier (the header-badge derivation).
 *
 * nuqs runs through the first-party NuqsTestingAdapter (real parsers); the
 * sync layer is dispatched by queryName; OtherDetail is stubbed (its own
 * behavior is covered by the Queue's suites — this pane only re-hosts it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({
  results: {} as Record<
    string,
    {
      data: unknown[];
      loading: boolean;
      fetching: boolean;
      error: unknown;
      invalidate: ReturnType<typeof vi.fn>;
    }
  >,
}));
const blank = () => ({
  data: [] as unknown[],
  loading: false,
  fetching: false,
  error: null as unknown,
  invalidate: vi.fn(),
});
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    H.results[queryName] ?? blank(),
  // The bulk-run wiring the pane now mounts subscribes to the sync bus. Without
  // this export the mock throws mid-render, which React reports only as "error
  // during concurrent rendering … recovered by rendering synchronously" — an
  // UNHANDLED error that fails the FILE while every expect still passes, so the
  // summary reads "46 passed" next to exit 1. Same stub PlansPane.test.tsx uses.
  onSyncBusEvent: () => () => {},
}));
// jsdom has no layout, so the real @tanstack/react-virtual renders zero rows
// (WI-5339 virtualization) — mock it to render every item (same seam as
// ChatConversation.test).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: `vk-${i}`,
        start: i * 52,
        size: 52,
      })),
    getTotalSize: () => opts.count * 52,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));
// OtherDetail is the Queue's own component — stub it to a marker that echoes
// the hosted item id and exposes the onDiscuss seam (parity behavior is the
// Queue suites' job).
vi.mock("@/app/admin/plans/PlanOtherList", () => ({
  OtherDetail: ({
    item,
    onDiscuss,
    onResolved,
    onNavigate,
    actionsPlacement,
    metadataPlacement,
  }: {
    item: { id: string };
    onDiscuss?: (i: unknown) => boolean;
    onResolved: () => void;
    onNavigate?: (i: unknown, actionId: "open" | "message-owner") => boolean;
    actionsPlacement?: "toolbar" | "after-body";
    metadataPlacement?: "toolbar" | "host";
  }) => (
    <div
      data-testid="other-detail"
      data-item={item.id}
      data-actions-placement={actionsPlacement}
      data-metadata-placement={metadataPlacement}
    >
      <button
        type="button"
        data-testid="stub-discuss"
        onClick={() => onDiscuss?.(item)}
      />
      <button type="button" data-testid="stub-resolve" onClick={onResolved} />
      <button
        type="button"
        data-testid="stub-open"
        onClick={() => onNavigate?.(item, "open")}
      />
      <button
        type="button"
        data-testid="stub-message-owner"
        onClick={() => onNavigate?.(item, "message-owner")}
      />
    </div>
  ),
  KIND_LABEL: {
    "plan-item": "item",
    "coord-escalation": "escalation",
    "coord-message": "message",
    "smoke-fail": "smoke",
    "operator-report": "report",
    improvement: "improvement",
    "standing-approval": "approval",
    conversation: "question",
    "scout-grade": "grade",
  },
}));

// SessionChatModal (P-007) does its own real work (fetch, SSE, OperatorChat) —
// out of scope for InboxPane's own suite (mirrors the OtherDetail stub above).
// The stub renders its props so this file can assert InboxPane wires the
// right owner id/label and reacts to onClose.
const chatModalProps = vi.fn();
vi.mock("../chat/SessionChatModal", () => ({
  default: (props: {
    sessionOwnerId: string | null;
    ownerLabel: string | null;
    onClose: () => void;
  }) => {
    chatModalProps(props);
    if (props.sessionOwnerId === null) return null;
    return (
      <div
        data-testid="session-chat-modal-stub"
        data-owner={props.sessionOwnerId}
        data-owner-label={props.ownerLabel ?? ""}
      >
        <button
          type="button"
          data-testid="session-chat-modal-close"
          onClick={props.onClose}
        />
      </div>
    );
  },
}));

// The sort picker is the shared Radix Select (design-primitives allowlists ZERO
// native <select>s in app code). Radix's popup does not open under jsdom, so
// stand in a native <select> carrying the SAME testId + aria-label — the same
// seam GoalProposalCard/FleetLaunchRow/PlanFilters already use.
vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    testId,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: React.ReactNode }>;
    ariaLabel?: string;
    testId?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const discussionProps = vi.fn();
vi.mock("../work-items/WorkItemDiscussion", () => ({
  WORK_ITEM_DISCUSSION_PARAM: "opcid",
  default: (props: {
    harnessSlug: string;
    workItemId: string;
    title?: string | null;
    onClose?: () => void;
  }) => {
    discussionProps(props);
    return (
      <div
        data-testid="work-item-discussion-stub"
        data-harness={props.harnessSlug}
        data-work-item={props.workItemId}
      >
        <button
          type="button"
          data-testid="work-item-discussion-close"
          onClick={props.onClose}
        />
      </div>
    );
  },
}));

import InboxPane, {
  formatRelativeDate,
  sortInboxItems,
  INBOX_SORTS,
  INBOX_SORT_IDS,
  DEFAULT_INBOX_SORT,
  inboxSortLabel,
} from "./InboxPane";
import {
  effectiveTier,
  useInboxPendingCount,
  isInboxActive,
  scopeInboxItems,
} from "./use-inbox-pending";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import {
  deriveRunCounts,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";

function mkItem(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: "coord-message",
    source: "coord",
    harnessSlug: "papercusp",
    planSlug: null,
    itemRef: null,
    title: `Title of ${id}`,
    body: `Body of ${id}`,
    status: "open",
    importance: "normal",
    tier: "decision",
    needsHuman: true,
    ownerAgentId: "su-abc",
    ownerLabel: "su · su-abc",
    triageState: "untriaged",
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [{ id: "ack", label: "Acknowledge", primary: true }],
    ref: { kind: "coord-message", msgId: `m-${id}` },
    ...over,
  } as AttentionItem;
}

function seedAttention(items: AttentionItem[]) {
  H.results["plans.attention"] = {
    data: [
      {
        key: "g1",
        kind: "plan",
        planSlug: "plan-x",
        harnessSlug: "papercusp",
        title: "plan-x",
        items,
        maxImportance: "normal",
      },
    ],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
}

function renderPane(
  searchParams = "",
  opts: { hasMemory?: boolean; layout?: "stack" | "split" } = {},
) {
  const onUrlUpdate = vi.fn();
  // `hasMemory` makes the adapter APPLY its own writes instead of only
  // reporting them, which is what lets a test observe the pane react to its
  // own setSel/setDiscussionRef. Off by default so the existing url-assertion
  // tests keep their fixed starting state.
  const view = render(<InboxPane layout={opts.layout} />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter
        searchParams={searchParams}
        hasMemory={opts.hasMemory}
        onUrlUpdate={onUrlUpdate}
      >
        {children}
      </NuqsTestingAdapter>
    ),
  });
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : "";
  // Re-render the SAME tree after re-seeding the feed: the pane sees a live
  // `plans.attention` update with no user action, which is the only way to
  // exercise a PASSIVE row removal.
  const refeed = () => view.rerender(<InboxPane layout={opts.layout} />);
  return { onUrlUpdate, lastQuery, refeed };
}

afterEach(() => {
  cleanup();
  H.results = {};
  chatModalProps.mockClear();
  discussionProps.mockClear();
});

describe("effectiveTier (badge/filter derivation)", () => {
  it("prefers the canonical tier field", () => {
    expect(effectiveTier(mkItem("a", { tier: "alert" }))).toBe("alert");
  });
  it("falls back to needsHuman → decision for pre-tier wire rows (Brief 21 lag)", () => {
    expect(
      effectiveTier(
        mkItem("a", { tier: undefined as never, needsHuman: true }),
      ),
    ).toBe("decision");
  });
  it("falls back to alert for smoke-fail / coord-escalation, else activity", () => {
    expect(
      effectiveTier(
        mkItem("a", {
          tier: undefined as never,
          needsHuman: false,
          kind: "smoke-fail",
        }),
      ),
    ).toBe("alert");
    expect(
      effectiveTier(
        mkItem("a", {
          tier: undefined as never,
          needsHuman: false,
          kind: "operator-report",
        }),
      ),
    ).toBe("activity");
  });
});

describe("useInboxPendingCount", () => {
  function Probe() {
    return <output data-testid="count">{useInboxPendingCount()}</output>;
  }

  /** Seed the ~100-byte badge aggregate (WI-5955). */
  function seedCounts(
    row: Partial<{
      decisionItems: number;
      decisionPlans: number;
      alerts: number;
      total: number;
    }>,
  ) {
    H.results["plans.attentionCounts"] = {
      data: [
        { decisionItems: 0, decisionPlans: 0, alerts: 0, total: 0, ...row },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
  }

  it("reads the decision count from the counts aggregate", () => {
    seedCounts({ decisionItems: 2, decisionPlans: 1, total: 4 });
    render(<Probe />);
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("does NOT read the full attention feed (WI-5955: the badge is mounted on every app start)", () => {
    // The whole point of the change: a seeded FEED with 3 decisions must not
    // move the badge — only the aggregate does. If someone reverts the badge to
    // deriving from `plans.attention`, this reds instead of silently restoring
    // a ~1MB fetch to every session.
    seedAttention([
      mkItem("d1"),
      mkItem("d2"),
      mkItem("d3", { tier: undefined as never, needsHuman: true }),
    ]);
    seedCounts({ decisionItems: 0, total: 0 });
    render(<Probe />);
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("degrades to 0 while the aggregate is still loading", () => {
    render(<Probe />);
    expect(screen.getByTestId("count").textContent).toBe("0");
  });
});

describe("<InboxPane>", () => {
  it("keeps the masthead from collapsing when loaded facets consume vertical space", () => {
    const css = readFileSync(join(__dirname, "inbox-pane.css"), "utf8");
    const mastheadRule =
      css.match(/\.op-inbox__masthead\s*\{[^}]*\}/)?.[0] ?? "";
    expect(mastheadRule).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it("keeps the tier-filter rail visible when the 360px pane is height-constrained", () => {
    const css = readFileSync(join(__dirname, "inbox-pane.css"), "utf8");
    const chipsRule = css.match(/\.op-inbox__chips\s*\{[^}]*\}/)?.[0] ?? "";
    expect(chipsRule).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it("does not visually line-clamp the full body inside an expanded row", () => {
    const css = readFileSync(join(__dirname, "inbox-pane.css"), "utf8");
    const bodyRule =
      css.match(
        /\.op-chat-sidebar \.op-inbox__detail \.ask-choice-question\s*\{[^}]*\}/,
      )?.[0] ?? "";
    expect(bodyRule).toMatch(/-webkit-line-clamp:\s*unset/);
    expect(bodyRule).toMatch(/overflow:\s*visible/);
  });

  /* ── List floor guard (inbox-three-column-resolver-states-2026-09-06 P-001) ──
     Measured live 2026-09-05 (EI-22478177553828828): at 1280×720 the split
     page rendered `.op-inbox__list` at 0px — zero of 77 rows. Every chrome
     sibling in `.op-inbox__master` was rigid (`flex: 0 0 auto`) and only the
     list flexed, so the column's whole vertical shortfall landed on the rows.
     jsdom has no layout, so these pin the CSS CONTRACT that makes that
     impossible; `e2e/inbox-list-floor.spec.ts` measures the real geometry. */
  describe("list floor guard (P-001)", () => {
    const css = readFileSync(join(__dirname, "inbox-pane.css"), "utf8");
    const rule = (selector: string): string =>
      css.match(
        new RegExp(
          selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}",
        ),
      )?.[0] ?? "";

    it("declares the floor ONCE on the pane root, so stack and split inherit the same value", () => {
      expect(rule(".op-inbox")).toMatch(/--op-inbox-list-floor:\s*\d+px/);
      // No layout-specific override may zero the list again.
      expect(css).not.toMatch(
        /\.op-inbox--split[^{]*\.op-inbox__list\s*\{[^}]*min-height:\s*0\b/,
      );
    });

    it("floors the list at the token and sizes it from zero, so chrome is measured before the rows", () => {
      const list = rule(".op-inbox__list");
      expect(list).toMatch(/min-height:\s*var\(--op-inbox-list-floor\b/);
      // `flex-basis: 0` is load-bearing: with `auto`, the virtualizer's total
      // height is the basis, and the flex algorithm then shrinks the CHROME in
      // proportion to that huge basis — collapsing the search box on any tall
      // list, not just a short viewport.
      expect(list).toMatch(/flex:\s*1\s+1\s+0(px)?\s*;/);
      expect(list).not.toMatch(/min-height:\s*0\s*;/);
    });

    it("lets the controls block yield (and scroll) before the list does — the chrome cap", () => {
      const controls = rule(".op-inbox__controls");
      expect(controls).toMatch(/flex:\s*0\s+1\s+auto/);
      expect(controls).toMatch(/overflow-y:\s*auto/);
      // …but never to nothing: the search field stays reachable.
      expect(controls).toMatch(/min-height:\s*[1-9]\d*px/);
    });

    it("keeps at least two whole rows visible", () => {
      const floor = Number(
        rule(".op-inbox").match(/--op-inbox-list-floor:\s*(\d+)px/)?.[1],
      );
      const rowMin = Number(
        rule(".op-inbox__rowbtn").match(/min-height:\s*(\d+)px/)?.[1],
      );
      expect(rowMin).toBeGreaterThan(0);
      expect(floor).toBeGreaterThanOrEqual(2 * rowMin);
    });
  });

  /* ── The rail column (inbox-three-column-resolver-states-2026-09-06 P-002) ──
     CSS contract for the split grid's first column. The DOM half — what
     renders in it — is under the layout="split" tests below. */
  describe("rail column (P-002)", () => {
    const css = readFileSync(join(__dirname, "inbox-pane.css"), "utf8");
    const rule = (selector: string): string =>
      css.match(
        new RegExp(
          selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}",
        ),
      )?.[0] ?? "";

    it("opens the split grid with the 210px rail, then the list band, then the aside", () => {
      expect(rule(".op-inbox--split")).toMatch(
        /grid-template-columns:\s*210px\s+minmax\(380px,\s*37%\)\s+minmax\(0,\s*1fr\)/,
      );
    });

    it("scrolls the rail internally instead of growing the page", () => {
      const rail = rule(".op-inbox__rail");
      expect(rail).toMatch(/overflow-y:\s*auto/);
      expect(rail).toMatch(/min-height:\s*0\b/);
    });

    it("at narrow widths hides the rail together with the list column while an item is selected", () => {
      const narrow = css.slice(css.indexOf("@media (max-width: 900px)"));
      expect(narrow.length).toBeGreaterThan(0);
      expect(narrow).toMatch(
        /\.op-inbox--split\[data-has-selection\] \.op-inbox__rail,\s*\.op-inbox--split\[data-has-selection\] \.op-inbox__column\s*\{[^}]*display:\s*none/,
      );
    });
  });

  /* ── The detail pane (inbox-three-column-resolver-states-2026-09-06 P-008 / D-003) ──
     Measured live 2026-09-05: the aside's detail had NO heading and the body
     ran the full 1055px pane width, chips strewn across the top. CSS contract
     for the split aside's grid; the DOM half is under the layout="split" tests. */
  describe("detail pane (P-008)", () => {
    const css = readFileSync(join(__dirname, "inbox-pane.css"), "utf8");
    const rule = (selector: string): string =>
      css.match(
        new RegExp(
          selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}",
        ),
      )?.[0] ?? "";

    it("lays the aside's detail out as head / body + rail / discussion, the body held to a 58ch measure beside a 190px rail", () => {
      const detail = rule(".op-inbox__aside .op-inbox__detail");
      expect(detail).toMatch(/display:\s*grid/);
      expect(detail).toMatch(
        /grid-template-columns:\s*minmax\(0,\s*58ch\)\s+190px/,
      );
      expect(detail).toMatch(
        /"head head"\s*"body rail"\s*"discussion discussion"/,
      );
      expect(rule(".op-inbox__aside .pc-items__detail")).toMatch(
        /grid-area:\s*body[^}]*max-width:\s*58ch/,
      );
      expect(rule(".op-inbox__detail-head")).toMatch(/grid-area:\s*head/);
      expect(rule(".op-inbox__detail-rail")).toMatch(/grid-area:\s*rail/);
      expect(rule(".op-inbox__detail-discussion")).toMatch(
        /grid-area:\s*discussion/,
      );
    });

    it("at narrow widths stacks head, rail, body, discussion in one column", () => {
      const narrow = css.slice(css.indexOf("@media (max-width: 900px)"));
      expect(narrow).toMatch(
        /\.op-inbox__aside \.op-inbox__detail\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*"head"\s*"rail"\s*"body"\s*"discussion"/,
      );
    });

    it("scopes the grid to the aside — the stack disclosure keeps its drawer chrome", () => {
      const drawer = rule(".op-inbox__detail");
      expect(drawer).not.toMatch(/display:\s*grid/);
      expect(drawer).toMatch(/border-top:\s*1px solid/);
    });
  });

  /* ── The accent token (inbox-three-column-resolver-states-2026-09-06 P-010) ──
     The 31 Aug board: "the hero, the row icons and the active filter use
     #3f7fd6; the app accent is sage-teal". The rendered blue came from a
     hardcoded royal-blue gradient family in this stylesheet. Every such site
     now takes `--accent`, so the portal's own accent shows through. */
  describe("accent token (P-010)", () => {
    const css = readFileSync(join(__dirname, "inbox-pane.css"), "utf8");
    const rule = (selector: string): string =>
      css.match(
        new RegExp(
          selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}",
        ),
      )?.[0] ?? "";

    it("carries no off-palette blue literal anywhere in the stylesheet", () => {
      expect(css).not.toMatch(/#1688ff|#0757b8|#0766d8|#3f7fd6/i);
    });

    it("paints the active scope pill, the masthead + rail icons, the row icon and the selected row from the accent token", () => {
      for (const selector of [
        ".op-inbox__chip.is-active",
        ".op-inbox__masthead-icon",
        ".op-inbox__rail-icon",
        ".op-inbox__row-icon",
        ".op-inbox__row.is-selected",
      ]) {
        const body = rule(selector);
        expect(body, selector).not.toBe("");
        expect(body, selector).toMatch(/var\(--accent\b/);
        expect(body, selector).not.toMatch(/#[0-9a-f]{6}\s*\d+%/i);
      }
    });
  });

  it('defaults to "Needs you" — decision-tier rows only, with chip counts', () => {
    seedAttention([
      mkItem("d1"),
      mkItem("a1", {
        tier: "alert",
        needsHuman: false,
        kind: "coord-escalation",
      }),
      mkItem("act1", { tier: "activity", needsHuman: false }),
    ]);
    renderPane();
    expect(screen.getByText("Resolution inbox")).toBeTruthy();
    expect(
      screen.getByTestId("inbox-masthead-count").getAttribute("aria-label"),
    ).toBe("1 item needs you");
    expect(screen.getByTestId("inbox-visible-scope").textContent).toBe(
      "1 of 3 shown",
    );
    expect(
      screen.getByRole("region", { name: "Inbox search and filters" }),
    ).toBeTruthy();
    expect(screen.getByTestId("inbox-row-d1")).toBeTruthy();
    expect(screen.queryByTestId("inbox-row-a1")).toBeNull();
    expect(screen.queryByTestId("inbox-row-act1")).toBeNull();
    expect(screen.getByTestId("inbox-filter-needs").textContent).toContain("1");
    expect(screen.getByTestId("inbox-filter-alerts").textContent).toContain(
      "1",
    );
    expect(screen.getByTestId("inbox-filter-all").textContent).toContain("3");
  });

  it("renders the kind label and owner/plan meta on a row", () => {
    seedAttention([mkItem("d1", { planSlug: "plan-x" })]);
    renderPane();
    const row = screen.getByTestId("inbox-row-d1");
    expect(row.textContent).toContain("message");
    expect(row.textContent).toContain("su · su-abc");
    expect(row.textContent).toContain("plan-x");
    expect(row.textContent).toContain("Title of d1");
  });

  it("deep-links the ?opci=all filter and shows every tier, decisions first", () => {
    seedAttention([
      mkItem("act1", { tier: "activity", needsHuman: false }),
      mkItem("d1"),
    ]);
    renderPane("?opci=all");
    const rows = screen
      .getAllByTestId(/^inbox-row-/)
      .map((x) => x.getAttribute("data-testid"));
    expect(rows).toEqual(["inbox-row-d1", "inbox-row-act1"]);
  });

  // deterministic-status-cards-2026-07-17 P-003: the curator-card drill-in bug.
  // A curator status card points at an OPERATIONAL/ALERT-tier escalation; under
  // the DEFAULT 'needs' filter that row is hidden, so a deep-linked ?opcis lands
  // on nothing ("Open just opens the inbox page"). The drill-in fix also writes
  // ?opci=all, which is what actually makes the row visible + selectable.
  it("an ALERT-tier deep-link keeps its row visible without clearing the current filter", () => {
    seedAttention([
      mkItem("coord-escalation:m9", {
        kind: "coord-escalation",
        tier: "alert",
        needsHuman: false,
      }),
      mkItem("d1"),
    ]);
    renderPane("?opcis=coord-escalation:m9"); // default 'needs' filter
    const row = screen.getByTestId("inbox-row-coord-escalation:m9");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByTestId("inbox-filter-needs").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      row
        .closest(".op-inbox__row")
        ?.contains(screen.getByTestId("other-detail")),
    ).toBe(true);
  });

  it("?opci=all + ?opcis SELECTS the deep-linked alert escalation (the drill-in target)", () => {
    seedAttention([
      mkItem("coord-escalation:m9", {
        kind: "coord-escalation",
        tier: "alert",
        needsHuman: false,
      }),
      mkItem("d1"),
    ]);
    renderPane("?opci=all&opcis=coord-escalation:m9");
    const row = screen.getByTestId("inbox-row-coord-escalation:m9");
    expect(row.getAttribute("aria-expanded")).toBe("true"); // selected
    expect(screen.getByTestId("other-detail").getAttribute("data-item")).toBe(
      "coord-escalation:m9",
    );
  });

  it("clicking a row writes ?opcis and expands OtherDetail inside that row", async () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    const { lastQuery } = renderPane("?opcis=d2");
    // Pre-seeded selection renders the detail for d2 only.
    const detail = screen.getByTestId("other-detail");
    expect(detail.getAttribute("data-item")).toBe("d2");
    expect(screen.getAllByTestId("other-detail")).toHaveLength(1);
    const row = screen.getByTestId("inbox-row-d2");
    const expanded = screen.getByTestId("inbox-expanded-d2");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("aria-controls")).toBe("inbox-expanded-d2");
    expect(expanded.contains(detail)).toBe(true);
    expect(detail.getAttribute("data-actions-placement")).toBe("after-body");
    expect(screen.getByTestId("inbox-row-d1")).toBeTruthy();
    // Clicking another row re-targets the selection (the adapter reports URL
    // writes on the next tick).
    fireEvent.click(screen.getByTestId("inbox-row-d1"));
    await waitFor(() => expect(lastQuery()).toContain("opcis=d1"));
    // Clicking the (now-)selected row clears it (toggle).
    fireEvent.click(screen.getByTestId("inbox-row-d1"));
    await waitFor(() => expect(lastQuery()).not.toContain("opcis="));
  });

  it("clicking the expanded row collapses it and a resolution refreshes the feed", async () => {
    seedAttention([mkItem("d1")]);
    const source = H.results["plans.attention"]!;
    const { lastQuery } = renderPane("?opcis=d1");

    fireEvent.click(screen.getByTestId("inbox-row-d1"));
    await waitFor(() => expect(lastQuery()).not.toContain("opcis="));

    cleanup();
    renderPane("?opcis=d1");
    fireEvent.click(screen.getByTestId("stub-resolve"));
    expect(source.invalidate).toHaveBeenCalledTimes(1);
  });

  it("toggles an inline row with Enter and Space while preserving aria state", async () => {
    seedAttention([mkItem("d1")]);
    const { lastQuery } = renderPane();
    const row = screen.getByTestId("inbox-row-d1");

    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(lastQuery()).toContain("opcis=d1"));

    cleanup();
    const rerendered = renderPane("?opcis=d1");
    const selectedRow = screen.getByTestId("inbox-row-d1");
    expect(selectedRow.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(selectedRow, { key: " " });
    await waitFor(() => expect(rerendered.lastQuery()).not.toContain("opcis="));
  });

  /* ── layout="split" (portal-work-two-pane-2026-09-01 P-001 / D-001) ─────
     The portal's /inbox full-page route asks for list + detail. The sidebar
     keeps the stack default, whose DOM must stay exactly as it was. */

  it("stack (the default) renders no aside and keeps the detail inline under its row", () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    renderPane("?opcis=d2");
    const root = screen.getByTestId("inbox-tab");
    expect(root.className).toBe("op-inbox");
    expect(root.getAttribute("data-layout")).toBe("stack");
    expect(root.hasAttribute("data-has-selection")).toBe(false);
    expect(screen.queryByTestId("inbox-aside")).toBeNull();
    // The column wrapper (display:contents in CSS) holds the master section.
    const column = root.querySelector(".op-inbox__column");
    expect(column?.contains(screen.getByTestId("inbox-master"))).toBe(true);
    const row = screen.getByTestId("inbox-row-d2");
    const expanded = screen.getByTestId("inbox-expanded-d2");
    expect(row.closest(".op-inbox__row")?.contains(expanded)).toBe(true);
  });

  it("split with no selection renders the empty aside and no detail anywhere", () => {
    seedAttention([mkItem("d1")]);
    renderPane("", { layout: "split" });
    const root = screen.getByTestId("inbox-tab");
    expect(root.className).toBe("op-inbox op-inbox--split");
    expect(root.getAttribute("data-layout")).toBe("split");
    expect(root.hasAttribute("data-has-selection")).toBe(false);
    const aside = screen.getByTestId("inbox-aside");
    // A focus landmark, never tab-reachable (mirrors the master section).
    expect(aside.getAttribute("tabindex")).toBe("-1");
    expect(aside.contains(screen.getByTestId("inbox-briefing"))).toBe(true);
    expect(screen.queryByTestId("other-detail")).toBeNull();
    expect(screen.queryByTestId("inbox-aside-back")).toBeNull();
    // The list column still holds the master section and its rows.
    const column = root.querySelector(".op-inbox__column");
    expect(column?.contains(screen.getByTestId("inbox-row-d1"))).toBe(true);
    expect(column?.contains(aside)).toBe(false);
  });

  it("split moves the selected item's detail into the aside — never inline under the row", () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    renderPane("?opcis=d2", { layout: "split" });
    const root = screen.getByTestId("inbox-tab");
    expect(root.hasAttribute("data-has-selection")).toBe(true);
    const aside = screen.getByTestId("inbox-aside");
    const expanded = screen.getByTestId("inbox-expanded-d2");
    const detail = screen.getByTestId("other-detail");
    expect(detail.getAttribute("data-item")).toBe("d2");
    expect(screen.getAllByTestId("other-detail")).toHaveLength(1);
    expect(aside.contains(expanded)).toBe(true);
    expect(expanded.contains(detail)).toBe(true);
    expect(detail.getAttribute("data-actions-placement")).toBe("after-body");
    expect(screen.queryByTestId("inbox-briefing")).toBeNull();
    expect(aside.contains(screen.getByTestId("inbox-aside-back"))).toBe(true);
    // The row stays the disclosure control; its target now lives in the aside.
    const row = screen.getByTestId("inbox-row-d2");
    expect(row.closest(".op-inbox__row")?.contains(expanded)).toBe(false);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.getAttribute("aria-controls")).toBe("inbox-expanded-d2");
    expect(document.getElementById("inbox-expanded-d2")).toBe(expanded);
    // The unselected row renders nothing extra.
    expect(screen.queryByTestId("inbox-expanded-d1")).toBeNull();
  });

  /* ── The detail pane (inbox-three-column-resolver-states-2026-09-06 P-008 / D-003) ── */
  it("split with a selection: the aside leads with the item's title as its heading + a meta line, the six chips re-homed as a labelled rail beside the body, and OtherDetail's own chips suppressed", () => {
    seedAttention([
      mkItem("d1"),
      mkItem("d2", {
        title: "Approve the key rotation",
        kind: "coord-escalation",
        planSlug: "plan-x",
        category: "deploy",
        whyGated: "protected",
        importance: "high",
        occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    ]);
    renderPane("?opcis=d2", { layout: "split" });
    const aside = screen.getByTestId("inbox-aside");
    const expanded = screen.getByTestId("inbox-expanded-d2");
    const head = screen.getByTestId("inbox-detail-head");
    const detail = screen.getByTestId("other-detail");
    const rail = screen.getByTestId("inbox-detail-rail");
    expect(aside.contains(head)).toBe(true);
    // The heading IS the item's title — the pane's one h2 (pre-P-008 the
    // detail rendered no heading element at all; the carried check).
    const h2 = screen.getByTestId("inbox-detail-title");
    expect(h2.tagName).toBe("H2");
    expect(h2.textContent).toBe("Approve the key rotation");
    expect(expanded.querySelectorAll("h1,h2,h3,h4,h5")).toHaveLength(1);
    // Meta line: kind · owner · plan-or-harness · when.
    expect(screen.getByTestId("inbox-detail-meta-kind").textContent).toBe(
      "escalation",
    );
    expect(screen.getByTestId("inbox-detail-meta-owner").textContent).toBe(
      "su · su-abc",
    );
    expect(screen.getByTestId("inbox-detail-meta-where").textContent).toBe(
      "plan-x",
    );
    const when = screen.getByTestId("inbox-detail-meta-when");
    expect(when.textContent).toBe("5m");
    expect(when.querySelector("time")?.getAttribute("datetime")).toBeTruthy();
    expect(when.querySelector("time")?.getAttribute("title")).toBeTruthy();
    // Source order head → card → rail; the grid places them.
    const kids = Array.from(expanded.children);
    expect(kids.indexOf(head)).toBeLessThan(kids.indexOf(detail));
    expect(kids.indexOf(detail)).toBeLessThan(kids.indexOf(rail));
    // The rail: the six facts as labelled rows, in the toolbar's order, the
    // chip classes riding along for their colour coding.
    expect(rail.tagName).toBe("DL");
    const rows = Array.from(
      rail.querySelectorAll(".op-inbox__detail-rail-row"),
    );
    expect(rows.map((r) => r.querySelector("dt")?.textContent)).toEqual([
      "Tier",
      "Kind",
      "Category",
      "Status",
      "Importance",
      "Harness",
    ]);
    expect(rows.map((r) => r.querySelector("dd")?.textContent)).toEqual([
      "Decisions",
      "escalation",
      "🔒 deploy",
      "open",
      "high",
      "papercusp",
    ]);
    expect(rail.querySelector(".pc-tier")?.className).toContain(
      "pc-tier--decision",
    );
    expect(rail.querySelector(".pc-category")?.className).toContain(
      "pc-category--protected",
    );
    // OtherDetail is told the host owns the metadata — no second chip row.
    expect(detail.getAttribute("data-metadata-placement")).toBe("host");
  });

  it("split meta line and rail omit what the item lacks — no blank segments, no Category/Harness rows", () => {
    seedAttention([
      mkItem("d2", {
        ownerLabel: undefined,
        ownerAgentId: undefined,
        planSlug: undefined,
        harnessSlug: undefined,
        occurredAt: undefined,
      }),
    ]);
    renderPane("?opcis=d2", { layout: "split" });
    expect(screen.getByTestId("inbox-detail-meta").textContent).toBe(
      "message",
    );
    expect(screen.queryByTestId("inbox-detail-meta-owner")).toBeNull();
    expect(screen.queryByTestId("inbox-detail-meta-where")).toBeNull();
    expect(screen.queryByTestId("inbox-detail-meta-when")).toBeNull();
    const rows = Array.from(
      screen
        .getByTestId("inbox-detail-rail")
        .querySelectorAll(".op-inbox__detail-rail-row dt"),
    ).map((dt) => dt.textContent);
    expect(rows).toEqual(["Tier", "Kind", "Status", "Importance"]);
  });

  it("stack keeps the disclosure unchanged — no heading, no rail, OtherDetail's own chips (P-008 is split-only)", () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    renderPane("?opcis=d2");
    expect(screen.getByTestId("inbox-expanded-d2")).toBeTruthy();
    expect(screen.queryByTestId("inbox-detail-head")).toBeNull();
    expect(screen.queryByTestId("inbox-detail-rail")).toBeNull();
    expect(
      screen.getByTestId("other-detail").getAttribute("data-metadata-placement"),
    ).toBe("toolbar");
  });

  /* ── The rail (inbox-three-column-resolver-states-2026-09-06 P-002 / D-001) ── */
  it("split renders the rail FIRST — scopes, facets and the collapsed masthead leave the list column", () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    renderPane("", { layout: "split" });
    const root = screen.getByTestId("inbox-tab");
    const rail = screen.getByTestId("inbox-rail");
    // Grid order IS column order: rail, then the list column, then the aside.
    expect(root.firstElementChild).toBe(rail);
    expect(rail.nextElementSibling?.className).toBe("op-inbox__column");
    expect(rail.tagName).toBe("NAV");
    // The scopes + kind facets moved, with their ids and handlers intact.
    expect(rail.contains(screen.getByTestId("inbox-filter-needs"))).toBe(true);
    expect(rail.contains(screen.getByTestId("inbox-filter-all"))).toBe(true);
    expect(rail.contains(screen.getByTestId("inbox-facet-coord-message"))).toBe(
      true,
    );
    // The masthead collapsed to `Inbox` + the count, in the rail head.
    expect(root.querySelector(".op-inbox__masthead")).toBeNull();
    expect(rail.querySelector(".op-inbox__rail-title")?.textContent).toBe(
      "Inbox",
    );
    const count = screen.getByTestId("inbox-masthead-count");
    expect(rail.contains(count)).toBe(true);
    expect(count.getAttribute("aria-label")).toBe("2 items need you");
    // The list column keeps search + sort and the rows — and nothing moved.
    const master = screen.getByTestId("inbox-master");
    expect(master.contains(rail)).toBe(false);
    const controls = master.querySelector(".op-inbox__controls");
    expect(controls?.querySelector(".op-inbox__chips")).toBeNull();
    expect(controls?.querySelector(".op-inbox__facets")).toBeNull();
    expect(controls?.contains(screen.getByTestId("inbox-search"))).toBe(true);
    expect(controls?.contains(screen.getByTestId("inbox-sort"))).toBe(true);
    expect(master.contains(screen.getByTestId("inbox-row-d1"))).toBe(true);
    // Exactly one of each — nothing is rendered twice.
    expect(screen.getAllByTestId("inbox-filter-needs")).toHaveLength(1);
    expect(screen.getAllByTestId("inbox-masthead-count")).toHaveLength(1);
  });

  it("split: the rail's scope and facet buttons still drive the same URL state", async () => {
    seedAttention([
      mkItem("d1"),
      mkItem("a1", {
        tier: "alert",
        needsHuman: false,
        kind: "coord-escalation",
      }),
    ]);
    const { lastQuery } = renderPane("", { layout: "split" });
    const rail = screen.getByTestId("inbox-rail");
    expect(screen.queryByTestId("inbox-row-a1")).toBeNull();
    fireEvent.click(screen.getByTestId("inbox-filter-all"));
    await waitFor(() => expect(lastQuery()).toContain("opci=all"));
    expect(
      screen.getByTestId("inbox-filter-all").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(rail.contains(screen.getByTestId("inbox-filter-all"))).toBe(true);
    await waitFor(() => expect(screen.getByTestId("inbox-row-a1")).toBeTruthy());
  });

  it("stack renders no rail — masthead, scopes and facets stay inside the master (D-001)", () => {
    seedAttention([mkItem("d1")]);
    renderPane("");
    expect(screen.queryByTestId("inbox-rail")).toBeNull();
    const master = screen.getByTestId("inbox-master");
    expect(master.querySelector(".op-inbox__masthead")).not.toBeNull();
    expect(master.contains(screen.getByTestId("inbox-masthead-count"))).toBe(
      true,
    );
    const controls = master.querySelector(".op-inbox__controls");
    expect(
      controls?.contains(screen.getByTestId("inbox-filter-needs")),
    ).toBe(true);
    expect(
      controls?.contains(screen.getByTestId("inbox-facet-coord-message")),
    ).toBe(true);
    // Stack order inside the master is unchanged: masthead first, then the
    // (bulk slot and) controls, then the list, then the foot.
    const order = Array.from(master.children).map((el) => el.className);
    expect(order[0]).toBe("op-inbox__masthead");
    expect(order.indexOf("op-inbox__controls")).toBeGreaterThan(0);
    expect(order.indexOf("op-inbox__controls")).toBeLessThan(
      order.indexOf("op-inbox__list"),
    );
    expect(order[order.length - 1]).toBe("op-inbox__foot");
  });

  /* ── The window strip + foot (inbox-three-column-resolver-states-2026-09-06 P-004) ── */
  // The server's page contract rides on the first group (readAttentionPageMeta):
  // `hasMore` is what mounts the "Showing N of M … Load more" window strip.
  function seedPagedAttention(items: AttentionItem[], total: number) {
    seedAttention(items);
    const first = H.results["plans.attention"]!.data[0] as Record<
      string,
      unknown
    >;
    first._meta = {
      total,
      offset: 0,
      limit: items.length,
      returned: items.length,
      hasMore: true,
      nextOffset: items.length,
    };
  }

  it("split: the window strip and the foot leave the list column for the aside's unselected state (P-004)", () => {
    seedPagedAttention([mkItem("d1"), mkItem("d2")], 180);
    renderPane("", { layout: "split" });
    const root = screen.getByTestId("inbox-tab");
    const master = screen.getByTestId("inbox-master");
    const column = root.querySelector(".op-inbox__column");
    const asideEmpty = screen.getByTestId("inbox-briefing");
    const feed = screen.getByTestId("inbox-aside-feed");
    const windowStrip = screen.getByTestId("inbox-attention-window");
    const loadMore = screen.getByTestId("inbox-load-more");
    const openQueue = screen.getByTestId("inbox-open-queue");
    // Both blocks render inside the aside's unselected state, ids intact.
    expect(asideEmpty.contains(feed)).toBe(true);
    expect(feed.contains(windowStrip)).toBe(true);
    expect(feed.contains(loadMore)).toBe(true);
    expect(feed.contains(openQueue)).toBe(true);
    expect(windowStrip.textContent).toContain(
      "Showing 2 of 180 attention items",
    );
    expect(feed.querySelector(".op-inbox__foot")?.textContent).toContain(
      "2 shown",
    );
    expect(loadMore.hasAttribute("disabled")).toBe(false);
    // The list column carries search + sort and the rows — nothing beneath.
    expect(column?.contains(windowStrip)).toBe(false);
    expect(column?.contains(openQueue)).toBe(false);
    expect(master.querySelector(".op-inbox__window")).toBeNull();
    expect(master.querySelector(".op-inbox__foot")).toBeNull();
    const order = Array.from(master.children).map((el) => el.className);
    expect(order[order.length - 1]).toBe("op-inbox__list");
    // Exactly one of each — nothing is rendered twice.
    expect(screen.getAllByTestId("inbox-attention-window")).toHaveLength(1);
    expect(screen.getAllByTestId("inbox-open-queue")).toHaveLength(1);
  });

  it("split with a selection: the aside is the detail — the feed controls are not duplicated into it", () => {
    seedPagedAttention([mkItem("d1"), mkItem("d2")], 180);
    renderPane("?opcis=d2", { layout: "split" });
    expect(screen.getByTestId("other-detail").getAttribute("data-item")).toBe(
      "d2",
    );
    expect(screen.queryByTestId("inbox-aside-feed")).toBeNull();
    expect(screen.queryByTestId("inbox-attention-window")).toBeNull();
    expect(screen.queryByTestId("inbox-open-queue")).toBeNull();
    expect(
      screen.getByTestId("inbox-master").querySelector(".op-inbox__foot"),
    ).toBeNull();
  });

  it("stack: the window strip and the foot stay in the master, in order (D-001)", () => {
    seedPagedAttention([mkItem("d1")], 180);
    renderPane("");
    const master = screen.getByTestId("inbox-master");
    expect(screen.queryByTestId("inbox-aside-feed")).toBeNull();
    const windowStrip = screen.getByTestId("inbox-attention-window");
    expect(master.contains(windowStrip)).toBe(true);
    expect(windowStrip.textContent).toContain(
      "Showing 1 of 180 attention items",
    );
    expect(master.contains(screen.getByTestId("inbox-load-more"))).toBe(true);
    expect(master.contains(screen.getByTestId("inbox-open-queue"))).toBe(true);
    const order = Array.from(master.children).map((el) => el.className);
    expect(order.indexOf("op-inbox__window")).toBeGreaterThan(
      order.indexOf("op-inbox__controls"),
    );
    expect(order.indexOf("op-inbox__window")).toBeLessThan(
      order.indexOf("op-inbox__list"),
    );
    expect(order[order.length - 1]).toBe("op-inbox__foot");
  });

  /* ── The briefing (inbox-three-column-resolver-states-2026-09-06 P-005 / D-002) ── */
  it("split with no selection: the briefing replaces the empty prompt — scope count, server total, the feed last", () => {
    seedPagedAttention([mkItem("d1"), mkItem("d2")], 180);
    renderPane("", { layout: "split" });
    const aside = screen.getByTestId("inbox-aside");
    const briefing = screen.getByTestId("inbox-briefing");
    expect(aside.contains(briefing)).toBe(true);
    expect(
      screen.queryByText("Select an item to read and answer it here"),
    ).toBeNull();
    // The headline and the "Need you" tile read the pane's scope count; the
    // "Tracked" tile reads the server total the page meta carries.
    expect(screen.getByTestId("inbox-briefing-headline").textContent).toBe(
      "2 items are waiting on you",
    );
    expect(screen.getByTestId("inbox-briefing-tile-need-you").textContent).toBe(
      "2Need you",
    );
    expect(screen.getByTestId("inbox-briefing-tile-tracked").textContent).toBe(
      "180Tracked",
    );
    // No persisted run in this fixture: the run tiles show — and no readout.
    expect(
      screen.getByTestId("inbox-briefing-tile-still-open").textContent,
    ).toBe("—Still open");
    expect(screen.queryByTestId("inbox-briefing-run")).toBeNull();
    // P-004's feed block rides last inside the briefing.
    expect(briefing.lastElementChild).toBe(
      screen.getByTestId("inbox-aside-feed"),
    );
  });

  it("stack renders no briefing (D-001)", () => {
    seedAttention([mkItem("d1")]);
    renderPane("");
    expect(screen.queryByTestId("inbox-briefing")).toBeNull();
    expect(screen.queryByTestId("inbox-briefing-headline")).toBeNull();
  });

  /* ── The live run in the aside (inbox-three-column-resolver-states-2026-09-06 P-006 / D-002) ── */
  const mkBulkRow = (
    itemId: string,
    outcome: BulkRunItem["outcome"],
  ): BulkRunItem => ({
    runId: "run-live",
    itemId,
    position: 0,
    kind: "coord-message",
    title: itemId,
    ref: {},
    ownerAgentId: null,
    outcome,
    actionId: null,
    rationale: null,
    draftAnswer: null,
    confidence: null,
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: null,
  });
  function seedBulkRun(phase: BulkRun["phase"], items: BulkRunItem[]) {
    const run: BulkRun = {
      runId: "run-live",
      phase,
      totalItems: items.length,
      autoResolved: 0,
      recommended: 0,
      skipped: 0,
      failed: 0,
      error: null,
      createdAt: "2026-09-06T00:00:00.000Z",
      startedAt: "2026-09-06T00:00:00.000Z",
      finishedAt: null,
      launchSnapshot: { model: "sonnet", effort: "high", account: "auto" },
    };
    H.results["plans.attentionBulkRun"] = {
      data: [{ run, items }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    return run;
  }

  it("split during a live run: the aside shows the run in progress, the rail card keeps its summary, and the rows carry their badges (P-006)", () => {
    seedAttention([mkItem("d1"), mkItem("d2"), mkItem("d3")]);
    seedBulkRun("running", [
      mkBulkRow("d1", "auto_resolved"),
      mkBulkRow("d2", "recommended"),
      mkBulkRow("d3", "pending"),
    ]);
    renderPane("", { layout: "split" });
    const aside = screen.getByTestId("inbox-aside");
    const running = screen.getByTestId("inbox-briefing-running");
    expect(aside.contains(running)).toBe(true);
    expect(screen.getByTestId("inbox-briefing-headline").textContent).toBe(
      "Papercup is resolving…",
    );
    // Counts from the item ROWS: 2 of 3 decided, 1 resolved, 1 for review, 1 left.
    expect(
      screen.getByTestId("inbox-briefing-running-decided").textContent,
    ).toBe("2 / 3");
    expect(screen.getByTestId("inbox-briefing-tile-resolved").textContent).toBe(
      "1Resolved",
    );
    expect(
      screen.getByTestId("inbox-briefing-tile-for-review").textContent,
    ).toBe("1For review");
    expect(screen.getByTestId("inbox-briefing-tile-left").textContent).toBe(
      "1Left",
    );
    // The glance grid and the last-run readout yield to the live view; the
    // feed block still rides last.
    expect(screen.queryByTestId("inbox-briefing-grid")).toBeNull();
    expect(screen.queryByTestId("inbox-briefing-run")).toBeNull();
    expect(screen.getByTestId("inbox-briefing").lastElementChild).toBe(
      screen.getByTestId("inbox-aside-feed"),
    );
    // Same run, two surfaces (D-002): the rail card's compact running state
    // stays beside the aside's full one.
    expect(
      screen
        .getByTestId("inbox-rail-bulk")
        .contains(screen.getByTestId("inbox-bulk-running")),
    ).toBe(true);
    // Per-row disposition badges DURING the run: decided rows carry theirs,
    // the row the resolver has not reached yet carries none.
    expect(screen.getByTestId("inbox-bulk-state-d1").textContent).toBe(
      "resolved",
    );
    expect(screen.getByTestId("inbox-bulk-state-d2").textContent).toBe(
      "for review",
    );
    expect(screen.queryByTestId("inbox-bulk-state-d3")).toBeNull();
    // "Keep working the list" hands focus to the first row.
    fireEvent.click(screen.getByTestId("inbox-briefing-keep-working"));
    expect(document.activeElement).toBe(screen.getByTestId("inbox-row-d1"));
  });

  it("split: a persisted review-phase run lands the aside on the review state with no deep link — grouped rows, Review, and Continue N retryable stating its scope (P-007)", () => {
    seedAttention([mkItem("d1"), mkItem("d2"), mkItem("d3")]);
    // d3 failed → the one continuable row; d2 waits on the owner.
    const rows = [
      mkBulkRow("d1", "auto_resolved"),
      mkBulkRow("d2", "recommended"),
      mkBulkRow("d3", "failed"),
    ];
    const run = seedBulkRun("review", rows);
    const counts = deriveRunCounts(rows, run);
    renderPane("", { layout: "split" });
    const briefing = screen.getByTestId("inbox-briefing");
    expect(screen.getByTestId("inbox-aside").contains(briefing)).toBe(true);
    expect(briefing.getAttribute("data-briefing-state")).toBe("last-run");
    expect(screen.getByTestId("inbox-briefing-headline").textContent).toBe(
      "Review the run",
    );
    expect(screen.queryByTestId("inbox-briefing-running")).toBeNull();
    expect(screen.getByTestId("inbox-briefing-run-line").textContent).toBe(
      `3 assessed · 1 auto-resolved · ${counts.unresolved} still open`,
    );
    const rowIds = Array.from(
      screen.getByTestId("inbox-briefing-rows").children,
    ).map((li) => li.getAttribute("data-testid"));
    expect(rowIds).toEqual([
      "inbox-briefing-row-recommendations",
      "inbox-briefing-row-failed",
    ]);
    expect(screen.getByTestId("inbox-briefing-review").textContent).toContain(
      `Review ${counts.unresolved} unresolved`,
    );
    // The resume control, from the pane's own `bulk.unreached` (D-002).
    expect(screen.getByTestId("inbox-briefing-continue").textContent).toContain(
      "Continue 1 retryable",
    );
    expect(
      screen.getByTestId("inbox-briefing-resume-scope").textContent,
    ).toContain("1 row was never reached");
    // Same run, two surfaces: the rail card is in ITS review state too.
    expect(
      screen
        .getByTestId("inbox-rail-bulk")
        .contains(screen.getByTestId("inbox-bulk-review")),
    ).toBe(true);
    // The feed block still rides last.
    expect(briefing.lastElementChild).toBe(
      screen.getByTestId("inbox-aside-feed"),
    );
  });

  /* ── The bulk card (inbox-three-column-resolver-states-2026-09-06 P-003 / D-002) ── */
  it("split: the bulk card renders at the FOOT of the rail — never in the list column", () => {
    seedAttention([mkItem("d1")]);
    renderPane("", { layout: "split" });
    const rail = screen.getByTestId("inbox-rail");
    const railBulk = screen.getByTestId("inbox-rail-bulk");
    expect(rail.lastElementChild).toBe(railBulk);
    const start = screen.getByTestId("inbox-bulk-start");
    expect(railBulk.contains(start)).toBe(true);
    // Exactly one mount: the strip is not ALSO in the master.
    expect(screen.getAllByTestId("inbox-bulk-start")).toHaveLength(1);
    expect(
      screen.getByTestId("inbox-master").querySelector(".op-inbox__bulk-slot"),
    ).toBeNull();
    // The card variant: text copy + a labelled button, same handler contract.
    const slot = start.closest(".op-inbox__bulk-slot");
    expect(slot?.getAttribute("data-bulk-resolver-strip-variant")).toBe("card");
    expect(slot?.textContent).toContain("1 row can be reviewed together");
    expect(start.textContent).toContain("Review bulk recommendation");
    expect(start.getAttribute("aria-label")).toBe(
      "Review bulk recommendation for 1 filtered item",
    );
  });

  it("stack: the bulk strip stays in the master as the full-width band (D-001)", () => {
    seedAttention([mkItem("d1")]);
    renderPane("");
    const start = screen.getByTestId("inbox-bulk-start");
    expect(screen.getByTestId("inbox-master").contains(start)).toBe(true);
    expect(screen.queryByTestId("inbox-rail-bulk")).toBeNull();
    expect(
      start
        .closest(".op-inbox__bulk-slot")
        ?.getAttribute("data-bulk-resolver-strip-variant"),
    ).toBe("strip");
    expect(start.getAttribute("aria-label")).toBe("Bulk resolve 1 filtered item");
  });

  it("split: clicking a row still writes ?opcis, and Back to list clears it", async () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    const { lastQuery } = renderPane("?opcis=d2", { layout: "split" });
    fireEvent.click(screen.getByTestId("inbox-row-d1"));
    await waitFor(() => expect(lastQuery()).toContain("opcis=d1"));
    fireEvent.click(screen.getByTestId("inbox-aside-back"));
    await waitFor(() => expect(lastQuery()).not.toContain("opcis="));
  });

  it("a row with an ownerAgentId shows a chat-launch button that opens SessionChatModal without also selecting the row", async () => {
    seedAttention([
      mkItem("d1", { ownerAgentId: "su-live-1", ownerLabel: "su · live-1" }),
    ]);
    const { lastQuery } = renderPane();
    // Modal starts closed.
    expect(chatModalProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionOwnerId: null }),
    );
    expect(screen.queryByTestId("session-chat-modal-stub")).toBeNull();

    fireEvent.click(screen.getByTestId("inbox-chat-open-d1"));

    // Opens the modal with the row's owner id + label…
    expect(
      screen.getByTestId("session-chat-modal-stub").getAttribute("data-owner"),
    ).toBe("su-live-1");
    expect(
      screen
        .getByTestId("session-chat-modal-stub")
        .getAttribute("data-owner-label"),
    ).toBe("su · live-1");
    // …and does NOT ALSO toggle the row's own selection (?opcis stays unset —
    // the click must not bubble to the row's onClick now that it's nested
    // inside a real <button>, not stopped by browser button-nesting rules).
    await new Promise((r) => setTimeout(r, 0));
    expect(lastQuery()).not.toContain("opcis=d1");
  });

  it("a row with no ownerAgentId renders no chat-launch button", () => {
    seedAttention([
      mkItem("d1", { ownerAgentId: undefined, ownerLabel: undefined }),
    ]);
    renderPane();
    expect(screen.queryByTestId("inbox-chat-open-d1")).toBeNull();
  });

  it("SessionChatModal onClose clears ?opcsession", async () => {
    seedAttention([mkItem("d1", { ownerAgentId: "su-live-1" })]);
    const { lastQuery } = renderPane("?opcsession=su-live-1");
    expect(screen.getByTestId("session-chat-modal-stub")).toBeTruthy();
    fireEvent.click(screen.getByTestId("session-chat-modal-close"));
    await waitFor(() => expect(lastQuery()).not.toContain("opcsession="));
  });

  it("the detail Open action launches the shared work-item popup for a needs-human item", async () => {
    seedAttention([
      mkItem("work-item-needs-human:WI-42", {
        kind: "work-item-needs-human",
        ref: {
          kind: "work-item-needs-human",
          workItemId: "WI-42",
          itemKind: "change",
        },
      }),
    ]);
    const { lastQuery } = renderPane("?opcis=work-item-needs-human%3AWI-42");
    fireEvent.click(screen.getByTestId("stub-open"));
    await waitFor(() => expect(lastQuery()).toContain("wpop=papercusp::WI-42"));
  });

  it("the detail Message owner action focuses the live agent session instead of showing a toast", () => {
    seedAttention([
      mkItem("wall-1", {
        ownerAgentId: "su-live-1",
        ownerLabel: "su · live-1",
      }),
    ]);
    renderPane("?opcis=wall-1");
    fireEvent.click(screen.getByTestId("stub-message-owner"));
    expect(
      screen.getByTestId("session-chat-modal-stub").getAttribute("data-owner"),
    ).toBe("su-live-1");
  });

  it("Discuss writes the scoped inline target instead of switching or seeding global chat", async () => {
    seedAttention([
      mkItem("work-item-needs-human:WI-42", {
        kind: "work-item-needs-human",
        ref: {
          kind: "work-item-needs-human",
          workItemId: "WI-42",
          itemKind: "change",
        },
      }),
    ]);
    const { lastQuery } = renderPane("?opcis=work-item-needs-human%3AWI-42");
    fireEvent.click(screen.getByTestId("stub-discuss"));
    await waitFor(() =>
      expect(lastQuery()).toContain("opcid=papercusp::WI-42"),
    );
  });

  it("a deep-linked discussion renders beneath the expanded work-item and close clears only opcid", async () => {
    seedAttention([
      mkItem("work-item-needs-human:WI-42", {
        kind: "work-item-needs-human",
        ref: {
          kind: "work-item-needs-human",
          workItemId: "WI-42",
          itemKind: "change",
        },
      }),
    ]);
    const { lastQuery } = renderPane(
      "?opcis=work-item-needs-human%3AWI-42&opcid=papercusp%3A%3AWI-42",
    );
    const expanded = screen.getByTestId(
      "inbox-expanded-work-item-needs-human:WI-42",
    );
    const discussion = screen.getByTestId("work-item-discussion-stub");
    expect(expanded.contains(screen.getByTestId("other-detail"))).toBe(true);
    expect(expanded.contains(discussion)).toBe(true);
    expect(discussion.getAttribute("data-harness")).toBe("papercusp");
    expect(discussion.getAttribute("data-work-item")).toBe("WI-42");

    const close = screen.getByTestId("work-item-discussion-close");
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(lastQuery()).not.toContain("opcid="));
    expect(lastQuery()).toContain("opcis=work-item-needs-human:WI-42");
    expect(document.activeElement).toBe(
      screen.getByTestId("inbox-row-work-item-needs-human:WI-42"),
    );
  });

  it("Discuss falls back to the Queue panel when the attention item has no canonical work-item id", async () => {
    seedAttention([mkItem("d1")]);
    const { lastQuery } = renderPane("?opcis=d1");
    fireEvent.click(screen.getByTestId("stub-discuss"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastQuery()).not.toContain("opcid=");
    expect(screen.queryByTestId("work-item-discussion-stub")).toBeNull();
  });

  it("shows the inbox-zero empty state when nothing needs the owner", () => {
    seedAttention([mkItem("a1", { tier: "alert", needsHuman: false })]);
    renderPane();
    expect(screen.getByTestId("inbox-empty").textContent).toContain(
      "Inbox zero",
    );
  });

  it("jumps to the full Queue by merge-writing tab=plans&view=queue on /adv", async () => {
    window.history.replaceState({}, "", "/adv?ws=w1");
    seedAttention([mkItem("d1")]);
    const { lastQuery } = renderPane();
    fireEvent.click(screen.getByTestId("inbox-open-queue"));
    await waitFor(() => {
      expect(lastQuery()).toContain("tab=plans");
      expect(lastQuery()).toContain("view=queue");
    });
  });

  it("surfaces a feed error", () => {
    H.results["plans.attention"] = {
      data: [],
      loading: false,
      fetching: false,
      error: new Error("coord down"),
      invalidate: vi.fn(),
    };
    renderPane();
    expect(screen.getByText(/coord down/)).toBeTruthy();
  });
});

/**
 * WI-41640 — the PASSIVE half of the focus-lifecycle chain. WI-41595/41601/41602
 * covered every path that runs a close handler; nothing below invokes one. Each
 * case removes the expanded detail out from under the owner and pins where
 * keyboard focus lands, including the two cases where it must NOT be moved.
 */
describe("inbox passive-unmount focus lifecycle (WI-41640)", () => {
  it("returns focus to the Inbox landmark when the live feed removes the expanded row", () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    const { refeed } = renderPane("?opcis=d1");
    const inside = screen.getByTestId("stub-resolve");
    inside.focus();
    expect(document.activeElement).toBe(inside);

    // The owner touched nothing — plans.attention simply stopped carrying d1.
    seedAttention([mkItem("d2")]);
    refeed();

    expect(screen.queryByTestId("inbox-row-d1")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("inbox-master"));
  });

  it("restores from inside the inline discussion, not only the detail actions", () => {
    const wi = mkItem("work-item-needs-human:WI-42", {
      kind: "work-item-needs-human",
      ref: {
        kind: "work-item-needs-human",
        workItemId: "WI-42",
        itemKind: "change",
      },
    });
    seedAttention([wi, mkItem("d2")]);
    const { refeed } = renderPane(
      "?opcis=work-item-needs-human%3AWI-42&opcid=papercusp%3A%3AWI-42",
    );
    const close = screen.getByTestId("work-item-discussion-close");
    close.focus();
    expect(document.activeElement).toBe(close);

    seedAttention([mkItem("d2")]);
    refeed();

    expect(screen.queryByTestId("work-item-discussion-stub")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("inbox-master"));
  });

  it("returns focus to the surviving row when resolving collapses the detail", async () => {
    seedAttention([mkItem("d1")]);
    renderPane("?opcis=d1", { hasMemory: true });
    const resolve = screen.getByTestId("stub-resolve");
    resolve.focus();
    fireEvent.click(resolve);

    await waitFor(() =>
      expect(screen.queryByTestId("inbox-expanded-d1")).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByTestId("inbox-row-d1"));
  });

  it("leaves a focus that was never inside the removed row exactly where it is", () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    const { refeed } = renderPane("?opcis=d1");
    const search = screen.getByTestId("inbox-search");
    search.focus();

    seedAttention([mkItem("d2")]);
    refeed();

    expect(screen.queryByTestId("inbox-row-d1")).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it("does not seize focus onto the Inbox when the owner had focus nowhere", () => {
    seedAttention([mkItem("d1"), mkItem("d2")]);
    const { refeed } = renderPane("?opcis=d1");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    seedAttention([mkItem("d2")]);
    refeed();

    expect(screen.queryByTestId("inbox-row-d1")).toBeNull();
    // A sidebar the live feed mutates unprompted must never take focus the
    // owner did not give it — this is what rules out ReportTakeoverLayer's
    // `activeElement === body` strand heuristic for this surface.
    expect(document.activeElement).toBe(document.body);
  });
});

// inbox-pane-active-scope-dates-filters-2026-07-19
describe("inbox active scope (P-101)", () => {
  const DAY = 86_400_000;
  it("drops the non-decision plan-item backlog but KEEPS needs-human plan decisions", () => {
    const backlog = mkItem("todo1", {
      kind: "plan-item",
      tier: "activity",
      needsHuman: false,
    });
    const blockedPlan = mkItem("blk1", {
      kind: "plan-item",
      tier: "alert",
      needsHuman: false,
    });
    const planDecision = mkItem("dec1", {
      kind: "plan-item",
      tier: "decision",
      needsHuman: true,
    });
    const kept = scopeInboxItems([backlog, blockedPlan, planDecision]);
    expect(kept.map((i) => i.id)).toEqual(["dec1"]);
    expect(isInboxActive(backlog)).toBe(false);
    expect(isInboxActive(blockedPlan)).toBe(false);
    expect(isInboxActive(planDecision)).toBe(true);
  });

  it("keeps alerts + decisions regardless of age, recency-bounds only stale activity", () => {
    const now = Date.now();
    const oldActivity = mkItem("act-old", {
      tier: "activity",
      needsHuman: false,
      occurredAt: new Date(now - 30 * DAY).toISOString(),
    });
    const freshActivity = mkItem("act-new", {
      tier: "activity",
      needsHuman: false,
      occurredAt: new Date(now - 1 * DAY).toISOString(),
    });
    const undatedActivity = mkItem("act-undated", {
      tier: "activity",
      needsHuman: false,
      occurredAt: undefined,
    });
    const oldAlert = mkItem("alert-old", {
      kind: "coord-escalation",
      tier: "alert",
      needsHuman: false,
      occurredAt: new Date(now - 90 * DAY).toISOString(),
    });
    expect(isInboxActive(oldActivity, now)).toBe(false); // stale FYI dropped
    expect(isInboxActive(freshActivity, now)).toBe(true);
    expect(isInboxActive(undatedActivity, now)).toBe(true); // undated → kept
    expect(isInboxActive(oldAlert, now)).toBe(true); // current-state, never expires
  });

  it('the pane "All" count reflects the SCOPED set (backlog excluded)', () => {
    seedAttention([
      mkItem("d1"),
      mkItem("todo1", {
        kind: "plan-item",
        tier: "activity",
        needsHuman: false,
      }),
      mkItem("todo2", { kind: "plan-item", tier: "alert", needsHuman: false }),
    ]);
    renderPane("?opci=all");
    expect(screen.getByTestId("inbox-filter-all").textContent).toContain("1");
    expect(screen.getByTestId("inbox-row-d1")).toBeTruthy();
    expect(screen.queryByTestId("inbox-row-todo1")).toBeNull();
  });
});

describe("inbox dates (P-2xx)", () => {
  it("formatRelativeDate renders compact relative labels", () => {
    const now = Date.parse("2026-07-19T12:00:00Z");
    expect(formatRelativeDate(new Date(now - 10_000).toISOString(), now)).toBe(
      "just now",
    );
    expect(
      formatRelativeDate(new Date(now - 5 * 60_000).toISOString(), now),
    ).toBe("5m");
    expect(
      formatRelativeDate(new Date(now - 3 * 3_600_000).toISOString(), now),
    ).toBe("3h");
    expect(
      formatRelativeDate(new Date(now - 2 * 86_400_000).toISOString(), now),
    ).toBe("2d");
    expect(formatRelativeDate(null, now)).toBeNull();
    expect(formatRelativeDate("not-a-date", now)).toBeNull();
  });

  it("renders a date element on a row that carries occurredAt", () => {
    seedAttention([
      mkItem("d1", {
        occurredAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }),
    ]);
    renderPane();
    const date = screen.getByTestId("inbox-date-d1");
    expect(date.textContent).toBe("2h");
  });

  it("renders no date element when occurredAt is absent", () => {
    seedAttention([mkItem("d1", { occurredAt: undefined })]);
    renderPane();
    expect(screen.queryByTestId("inbox-date-d1")).toBeNull();
  });
});

describe("inbox search + kind facets (P-3xx)", () => {
  it("the ?opcq search narrows the list over title/body/owner", () => {
    seedAttention([
      mkItem("d1", {
        title: "Deploy the release",
        tier: "alert",
        needsHuman: false,
      }),
      mkItem("d2", {
        title: "Rotate the API key",
        tier: "alert",
        needsHuman: false,
      }),
    ]);
    renderPane("?opci=all&opcq=release");
    expect(screen.getByTestId("inbox-row-d1")).toBeTruthy();
    expect(screen.queryByTestId("inbox-row-d2")).toBeNull();
  });

  it("typing in the search box writes ?opcq", async () => {
    seedAttention([mkItem("d1")]);
    const { lastQuery } = renderPane();
    fireEvent.change(screen.getByTestId("inbox-search"), {
      target: { value: "foo" },
    });
    await waitFor(() => expect(lastQuery()).toContain("opcq=foo"));
  });

  it("a selected ?opck kind facet narrows to that kind", () => {
    seedAttention([
      mkItem("d1", {
        kind: "coord-escalation",
        tier: "alert",
        needsHuman: false,
      }),
      mkItem("d2", { kind: "coord-message", tier: "alert", needsHuman: false }),
    ]);
    renderPane("?opci=all&opck=coord-escalation");
    expect(screen.getByTestId("inbox-row-d1")).toBeTruthy();
    expect(screen.queryByTestId("inbox-row-d2")).toBeNull();
  });

  it("shows data-driven kind facets with counts EXPANDED by default, with no toggle (WI-40982)", () => {
    seedAttention([
      mkItem("d1", {
        kind: "coord-escalation",
        tier: "alert",
        needsHuman: false,
      }),
      mkItem("d2", {
        kind: "coord-escalation",
        tier: "alert",
        needsHuman: false,
      }),
      mkItem("d3", { kind: "coord-message", tier: "alert", needsHuman: false }),
    ]);
    // No ?opcf — the owner's ask (2026-08-23) is that the facets are simply open.
    renderPane("?opci=all");
    const facet = screen.getByTestId("inbox-facet-coord-escalation");
    expect(facet.textContent).toContain("escalation");
    expect(facet.textContent).toContain("2");
    expect(screen.getByTestId("inbox-facet-coord-message")).toBeTruthy();
    // Both halves pinned: facets present AND the disclosure button gone.
    expect(screen.queryByTestId("inbox-filter-toggle")).toBeNull();
  });

  it("exposes the sort picker in the toolbar and writes ?opcsort (WI-40982)", async () => {
    seedAttention([mkItem("d1")]);
    const { lastQuery } = renderPane();
    const sort = screen.getByTestId("inbox-sort") as HTMLSelectElement;
    expect(sort.getAttribute("aria-label")).toBe("Sort inbox");
    expect(sort.value).toBe(DEFAULT_INBOX_SORT);

    fireEvent.change(sort, { target: { value: "oldest" } });
    await waitFor(() => expect(lastQuery()).toContain("opcsort=oldest"));
  });

  it("renders rows in the ?opcsort order, over the filtered set only", () => {
    // Titles run inverse to age, so "oldest" and "title" disagree with the
    // default priority order — a fixture where the orders coincide would pass
    // against a sort wired to nothing.
    const common = {
      tier: "alert" as const,
      needsHuman: false,
      kind: "coord-message" as const,
    };
    seedAttention([
      mkItem("zulu", {
        ...common,
        title: "Zulu",
        occurredAt: "2026-08-09T00:00:00Z",
      }),
      mkItem("alpha", {
        ...common,
        title: "Alpha",
        occurredAt: "2026-08-01T00:00:00Z",
      }),
    ]);
    const rowsInOrder = () =>
      Array.from(document.querySelectorAll('[data-testid^="inbox-row-"]')).map(
        (el) => el.getAttribute("data-testid"),
      );

    const first = renderPane("?opci=all");
    expect(rowsInOrder()).toEqual(["inbox-row-zulu", "inbox-row-alpha"]); // newest first
    cleanup();
    void first;

    renderPane("?opci=all&opcsort=oldest");
    expect(rowsInOrder()).toEqual(["inbox-row-alpha", "inbox-row-zulu"]);
    cleanup();

    // …and the tier filter still governs WHICH rows exist under a chosen sort:
    // "Needs you" admits only decision-tier rows, whatever the order.
    renderPane("?opci=needs&opcsort=oldest");
    expect(rowsInOrder()).toEqual([]);
  });
});

describe("inbox sort orders (WI-40982)", () => {
  // The fixture is built so that ALL SIX orders land on a DIFFERENT permutation
  // of the same three rows. That is the whole point: on a careless fixture the
  // orders coincide, and every assertion then passes even against a comparator
  // that silently fell through to the default — a green test measuring nothing.
  //   priority → b,a,c   newest → a,c,b   oldest  → b,c,a
  //   kind     → c,a,b   agent  → a,b,c   title   → c,b,a
  const items = [
    mkItem("a", {
      occurredAt: "2026-08-09T00:00:00Z",
      title: "Zulu",
      kind: "improvement",
      ownerLabel: "alfa",
      tier: "alert",
      needsHuman: false,
    }),
    mkItem("b", {
      occurredAt: "2026-08-01T00:00:00Z",
      title: "Mike",
      kind: "coord-message",
      ownerLabel: "mike",
      tier: "decision",
      needsHuman: true,
    }),
    mkItem("c", {
      occurredAt: "2026-08-05T00:00:00Z",
      title: "Alpha",
      kind: "coord-escalation",
      ownerLabel: "zeta",
      tier: "alert",
      needsHuman: false,
    }),
  ] as AttentionItem[];
  const ids = (sort?: Parameters<typeof sortInboxItems>[1]) =>
    sortInboxItems(items, sort).map((i) => i.id);

  it("gives every offered order a DISTINCT result on this fixture (the guard on the guards)", () => {
    const seen = INBOX_SORT_IDS.map((id) => ids(id).join(""));
    expect(new Set(seen).size, `orders collided: ${seen.join(" | ")}`).toBe(
      seen.length,
    );
  });

  it("defaults to priority: decisions above alerts, newest within a tier", () => {
    expect(ids()).toEqual(["b", "a", "c"]);
    expect(ids(DEFAULT_INBOX_SORT)).toEqual(ids());
  });

  it("orders by date in both directions, ignoring tier", () => {
    // b is the DECISION and also the oldest — so a date sort that quietly kept
    // the tier rank would be caught here rather than agreeing by accident.
    expect(ids("newest")).toEqual(["a", "c", "b"]);
    expect(ids("oldest")).toEqual(["b", "c", "a"]);
  });

  it("orders by kind label, agent and title", () => {
    expect(ids("kind")).toEqual(["c", "a", "b"]); // escalation < improvement < message
    expect(ids("agent")).toEqual(["a", "b", "c"]); // alfa < mike < zeta
    expect(ids("title")).toEqual(["c", "b", "a"]); // Alpha < Mike < Zulu
  });

  it('sorts an UNDATED row last in BOTH directions — unknown is not "oldest"', () => {
    const withUndated = [
      ...items,
      mkItem("u", { occurredAt: undefined, tier: "alert", needsHuman: false }),
    ];
    expect(
      sortInboxItems(withUndated, "newest")
        .map((i) => i.id)
        .at(-1),
    ).toBe("u");
    expect(
      sortInboxItems(withUndated, "oldest")
        .map((i) => i.id)
        .at(-1),
    ).toBe("u");
  });

  it("is STABLE and never adds or drops a row, under every offered order", () => {
    for (const id of INBOX_SORT_IDS) {
      const out = sortInboxItems(items, id);
      expect(
        out
          .map((i) => i.id)
          .slice()
          .sort(),
        `sort=${id}`,
      ).toEqual(["a", "b", "c"]);
      // Same input twice ⇒ same output (no Array#sort instability on ties).
      expect(
        sortInboxItems(items, id).map((i) => i.id),
        `sort=${id}`,
      ).toEqual(out.map((i) => i.id));
    }
    expect(sortInboxItems([], "newest")).toEqual([]);
  });

  it("exposes a label for every offered order, and no duplicate ids", () => {
    expect(new Set(INBOX_SORT_IDS).size).toBe(INBOX_SORT_IDS.length);
    expect(INBOX_SORT_IDS).toContain(DEFAULT_INBOX_SORT);
    for (const s of INBOX_SORTS) {
      expect(inboxSortLabel(s.id)).toBe(s.label);
      expect(s.label.trim()).not.toBe("");
    }
  });
});
