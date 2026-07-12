// @vitest-environment jsdom
//
// LearningTab render coverage — the /adv "Learning" tab (operator-learning-tab-2026-06-09).
// Mounts the tab against realistic `learning.improvements` / `learning.gym` /
// `learning.apiary` / `learning.scout` snapshots (useSyncQuery +
// nuqs mocked, the pinned sibling pattern — see AdvConversationsTab.test.tsx).
// useSyncQuery dispatches on queryName so each sub-view gets its own shape. Asserts the
// Improvements scoreboard + lanes (default view), the lifecycle navigation, the Gym
// and Benchmark views, and the Scout rails/tick view. Empty states are pinned per view.
// Scout grading (B-07, scout-idea-grading-2026-06-12): star control, attribution
// chip, optimistic write through the `blender:grade-idea` tool proxy (+ rollback),
// the `?grade=` note popover, and the lens-weight strip.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const nuqsState: Record<string, unknown> = {
  lview: "improvements",
  lane: "all",
  tab: null,
  grade: null,
  irail: null,
  rrubric: null,
  lretain: null,
  lhive: "",
  slug: null,
};
// Capture the setter per key so tests can assert the hive picker writes ?lhive.
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    const setter = (nuqsSetters[key] ??= vi.fn((v: unknown) => {
      nuqsState[key] = v;
    }));
    return [nuqsState[key], setter];
  },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsString: { withDefault: () => ({}) },
}));

vi.mock("@/app/_components/RubricsPanel", () => ({
  default: ({ onSelect }: { onSelect?: (id: string) => void }) => (
    <button data-testid="rubrics-panel" onClick={() => onSelect?.("rubric-1")}>
      rubrics-panel
    </button>
  ),
}));
vi.mock("@/app/_components/RubricDetailPanel", () => ({
  default: ({
    rubricId,
    onBack,
  }: {
    rubricId: string;
    onBack?: () => void;
  }) => (
    <div data-testid="rubric-detail">
      detail:{rubricId}
      <button onClick={onBack}>back</button>
    </div>
  ),
}));
vi.mock("@/app/adv/create/ObservationsPanel", () => ({
  default: () => <div data-testid="observations-panel" />,
}));

// LearningTab's dropdowns now use the themed <Select> (Radix). Mock it as a native
// <select> with the same contract (mirrors AdvShell.test) so the hive-lens
// assertions (getByLabelText / option roles / value / disabled) still hold; the
// placeholder is rendered as the value="" option so the "no hives yet" case asserts.
vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    ariaLabel?: string;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

const improvementsDigest = {
  generatedAt: new Date(0).toISOString(),
  total: 135,
  open: 117,
  byKind: { bug: 107, change: 28 },
  bySeverity: { major: 87, minor: 40, critical: 5, nit: 3 },
  byState: { open: 117, resolved: 15, closed: 3 },
  autoEligible: [
    {
      id: "EI-75",
      kind: "bug",
      title: "cup:spawn children are coordination-MUTE",
      scope: "operator",
      severity: "critical",
      state: "open",
      assignee: null,
      assignedAt: null,
      attempts: 0,
      tier: "auto",
      score: 46,
      ageDays: 2.6,
      tierReason: "no protected path → AUTO",
      ideaType: "process",
    },
  ],
  humanQueue: [
    {
      id: "EI-85",
      kind: "bug",
      title: "Peer restarts massacre in-flight spawns",
      scope: "operator",
      severity: "critical",
      state: "open",
      assignee: null,
      assignedAt: null,
      attempts: 0,
      tier: "human",
      score: 42,
      ageDays: 2.5,
      tierReason: "protected keyword deploy → human",
      ideaType: "process",
    },
  ],
  likelyDuplicates: [],
  recurringSignatures: [],
  headline: "papercusp-improvement digest: 135 captured (117 open)",
  // P-041 flow scoreboard — flows, not stocks. lastTickAt is relative to now
  // because the strip's watchdog-health tone is computed against Date.now().
  flow: {
    captured7d: 12,
    resolved7d: 8,
    net7d: 4,
    medianOpenAgeDays: 14.2,
    recurringSignatureCount: 3,
    watchdog: {
      lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      ticks24h: 96,
      captured24h: 5,
    },
  },
};

const gymSnapshot = {
  proposals: [
    {
      id: "v1__worker",
      harnessSlug: "papercup-gym",
      cycle: 3,
      role: "worker",
      rationale: "tighten the worker acceptance check",
      devAnchorDelta: 0.042,
      costDelta: -0.01,
      status: "accepted",
      createdAt: 1,
      decidedAt: 2,
    },
    {
      id: "v2__architect",
      harnessSlug: "papercup-gym",
      cycle: 3,
      role: "architect",
      rationale: "more explicit chunk sizing",
      devAnchorDelta: -0.018,
      costDelta: 0.02,
      status: "rejected",
      createdAt: 1,
      decidedAt: 2,
    },
  ],
  autoloops: [
    {
      harnessSlug: "papercup-gym",
      enabled: true,
      status: "running",
      budgetUsd: 20,
      spentUsd: 4.5,
      lastCycle: 3,
    },
  ],
};

// Composites use the LIVE judge scale (0..10 — real gen-0 rows sit at 4.06..5.95),
// not 0..1: the BenchmarkTrend projection must stay scale-free (B-12).
const apiarySnapshot = {
  instances: [
    {
      instanceId: "gen0-bbb2222-ws",
      codeSha: "bbb2222",
      createdAt: new Date(2_000_000).toISOString(),
      totalRuns: 20,
      successfulRuns: 16,
      successRate: 0.8,
      meanComposite: 5.95,
      meanTimeToGreenSecs: 95,
      meanTokens: 12000,
      escalationRate: 0.1,
      firstAttemptRate: 0.6,
    },
    {
      instanceId: "gen0-aaa1111-ws",
      codeSha: "aaa1111",
      createdAt: new Date(1_000_000).toISOString(),
      totalRuns: 20,
      successfulRuns: 14,
      successRate: 0.7,
      meanComposite: 4.06,
      meanTimeToGreenSecs: 110,
      meanTokens: 13500,
      escalationRate: 0.15,
      firstAttemptRate: 0.5,
    },
  ],
};

const knowledgeSnapshot = {
  insights: {
    count: 38,
    recent: [
      {
        slug: "adding-a-sync-query",
        title: "Adding a sync query",
        description: "The per-entry resolver recipe.",
        status: "active",
        tags: ["sync"],
        modifiedAt: new Date(3_000_000).toISOString(),
      },
      {
        slug: "postgres-js-jsonb-binding",
        title: "postgres.js jsonb binding",
        description: "sql.json throws under getOrgPg.",
        status: "active",
        tags: ["pg"],
        modifiedAt: new Date(2_000_000).toISOString(),
      },
    ],
  },
  memory: {
    totalMemories: 168,
    entityRows: 1829,
    feedback30d: 3,
    recalls7d: 40,
    zeroHit7d: 10,
    zeroHitRate7d: 0.25,
    topScoreP50: 0.52,
    topScoreP90: 0.74,
    fragmentHits7d: 0,
  },
};

const scoutSnapshot = {
  totalRouted: 4,
  railCounts: [
    { rail: "plan", count: 3 },
    { rail: "gym", count: 1 },
  ],
  recent: [
    {
      ideaId: "idea-1",
      lens: "reframing",
      rail: "plan",
      routedRef: "plan:scout-cache-warmup",
      title: "Cache-warmup plan draft",
      routedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      outcome: "pending",
      humanGrade: null,
      humanFeedback: null,
      gradedBy: null,
    },
    {
      ideaId: "idea-2",
      lens: "analogical",
      rail: "gym",
      routedRef: "gym:proposal-7",
      title: "Tighter scoper prompt",
      routedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      outcome: "won",
      // Queen auto-graded (C-1c) — the row shows the attribution chip; owner regrade stays open.
      humanGrade: 4,
      humanFeedback: "Sharp framing — ship it",
      gradedBy: "Queen",
    },
  ],
  lastTick: {
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    outcome: "gated",
    detail: "min-interval",
  },
};

let improvementsResult: Record<string, unknown> = {
  data: [improvementsDigest],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let gymResult: Record<string, unknown> = {
  data: [gymSnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let apiaryResult: Record<string, unknown> = {
  data: [apiarySnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let knowledgeResult: Record<string, unknown> = {
  data: [knowledgeSnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let scoutResult: Record<string, unknown> = {
  data: [scoutSnapshot],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let hiveEvalResult: Record<string, unknown> = {
  data: [{ instances: [] }],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
// P-042: the tab-level hive picker reuses learning.hiveList; the Learnings view
// reads learning.hive + learningPacks.list. Defaults: two hives so the picker
// renders real options.
let hiveListResult: Record<string, unknown> = {
  data: [
    { slug: "alpha-hive", remote: false },
    { slug: "beta-hive", remote: true },
  ],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let hiveResult: Record<string, unknown> = {
  data: [{ hive: "alpha-hive", rows: [], packs: [], organicCount: 0 }],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
// Per-query args the tab passed — asserted by the P-042 hive-lens tests.
const seenArgs: Record<string, unknown> = {};
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { queryName: string; args?: unknown }) => {
    seenArgs[opts.queryName] = opts.args;
    return opts.queryName === "learning.gym"
      ? gymResult
      : opts.queryName === "learning.apiary"
        ? apiaryResult
        : opts.queryName === "learning.hiveEvalTrend"
          ? hiveEvalResult
          : opts.queryName === "learning.knowledge"
            ? knowledgeResult
            : opts.queryName === "learning.scout"
              ? scoutResult
              : opts.queryName === "learning.hiveList"
                ? hiveListResult
                : opts.queryName === "learning.hive"
                  ? hiveResult
                  : opts.queryName === "learningPacks.list" ||
                      opts.queryName === "learningPacks.candidates"
                    ? {
                        data: [],
                        loading: false,
                        fetching: false,
                        error: null,
                        invalidate: vi.fn(),
                      }
                    : improvementsResult;
  },
}));

// Lexicon resolver mocked to ECHO its key (t('pot') → 'pot', t('brain') → 'brain',
// t('contributor') → 'contributor') — isolates the routed copy from the THE_HIVE
// flag hook so assertions pin the ROUTED KEY, not a pack word (restore-pot-lexicon P-006).
vi.mock("@/lib/useLexicon", () => ({ useLexicon: () => (k: string) => k }));

import LearningTab, { ScoutView } from "./LearningTab";

beforeEach(() => {
  nuqsState.lview = "improvements";
  nuqsState.lane = "all";
  nuqsState.tab = null;
  nuqsState.grade = null;
  nuqsState.irail = null;
  nuqsState.rrubric = null;
  nuqsState.lretain = null;
  nuqsState.lhive = "";
  nuqsState.slug = null;
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  for (const k of Object.keys(seenArgs)) delete seenArgs[k];
  improvementsResult = {
    data: [improvementsDigest],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  gymResult = {
    data: [gymSnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  apiaryResult = {
    data: [apiarySnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  knowledgeResult = {
    data: [knowledgeSnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  scoutResult = {
    data: [scoutSnapshot],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  hiveEvalResult = {
    data: [{ instances: [] }],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  hiveListResult = {
    data: [
      { slug: "alpha-hive", remote: false },
      { slug: "beta-hive", remote: true },
    ],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  hiveResult = {
    data: [{ hive: "alpha-hive", rows: [], packs: [], organicCount: 0 }],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
});
afterEach(() => cleanup());

describe("LearningTab — Improvements view (default)", () => {
  it("renders the scoreboard from the digest rollups", () => {
    render(<LearningTab />);
    expect(screen.getByRole("tab", { name: /Improvements/ })).toBeTruthy();
    expect(screen.getByText("135")).toBeTruthy(); // captured total
    expect(screen.getByText("117")).toBeTruthy(); // open
    expect(screen.getByText("15")).toBeTruthy(); // resolved (byState)
  });

  it("lists both lanes in the all view", () => {
    render(<LearningTab />);
    expect(
      screen.getByText("cup:spawn children are coordination-MUTE"),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Peer restarts massacre in-flight spawns"),
    ).toHaveLength(1);
    expect(screen.getByText("EI-75")).toBeTruthy();
    expect(screen.queryByText("Decide next")).toBeNull();
  });

  it("shows the four-stage loop and keeps Improvements inside Improve", () => {
    render(<LearningTab />);
    expect(screen.getByRole("tab", { name: "Auto-fixable" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Needs review" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Observe" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Improve" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Verify" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Retain" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Ideas" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Gym" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Improvements/ })).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Improve" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("uses visual hierarchy instead of explanatory prose", () => {
    render(<LearningTab />);
    expect(screen.queryByText("How this works")).toBeNull();
    expect(document.querySelector(".pc-learning__copy")).toBeNull();
  });

  it("renders the empty state when no improvements match the lane", () => {
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          total: 0,
          open: 0,
          autoEligible: [],
          humanQueue: [],
          byState: {},
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("Nothing in this lane")).toBeTruthy();
  });

  it("skips the dashboard and duplicate decision rail for a sparse queue", () => {
    improvementsResult = {
      data: [
        {
          ...improvementsDigest,
          total: 1,
          open: 1,
          autoEligible: [],
          humanQueue: [improvementsDigest.humanQueue[0]],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(
      document.querySelector(".pc-learning-visual__layout--improvements"),
    ).toBeNull();
    expect(document.querySelector(".pc-hqdrain")).toBeNull();
    expect(
      screen.getByText("Peer restarts massacre in-flight spawns"),
    ).toBeTruthy();
    expect(screen.queryByText("Captured improvements")).toBeNull();
    expect(document.querySelector(".pc-learning__lanecol")).toBeNull();
  });

  it("renders the P-041 flow strip above the scoreboard — in/out, net, median age, recurrence, watchdog health", () => {
    render(<LearningTab />);
    fireEvent.click(screen.getByRole("button", { name: "Loop diagnostics" }));
    const strip = screen.getByLabelText("Improvement flow (trailing window)");
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain("12"); // captured 7d
    expect(strip.textContent).toContain("8"); // resolved 7d
    expect(strip.textContent).toContain("+4"); // net arrow (backlog grew)
    expect(strip.textContent).toContain("median open");
    expect(strip.textContent).toContain("14d"); // median open age label
    expect(strip.textContent).toContain("3 recurring");
    // last tick 10 minutes ago → green ("Nm ago" label, wd-good chip)
    expect(strip.textContent).toMatch(/watchdog\s*\d+m ago/);
    expect(strip.querySelector(".pc-learning__flowchip--wd-good")).toBeTruthy();
    expect(strip.textContent).toContain("96 ticks / 5 captured · 24h");
  });

  it("omits the flow strip when the resolver row carries no flow block (older payloads)", () => {
    const { flow: _flow, ...digestSansFlow } = improvementsDigest as Record<
      string,
      unknown
    > & { flow: unknown };
    improvementsResult = {
      data: [digestSansFlow],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    fireEvent.click(screen.getByRole("button", { name: "Loop diagnostics" }));
    expect(
      screen.queryByLabelText("Improvement flow (trailing window)"),
    ).toBeNull();
    expect(screen.getByText("135")).toBeTruthy(); // the stock scoreboard still renders
  });

  it("renders the dispatch-ledger chip when flow.dispatch is present — fired/fixed counts, red on dead dispatches (P-010 / B-04)", () => {
    const base = improvementsDigest as Record<string, unknown> & {
      flow: Record<string, unknown>;
    };
    const dispatch = {
      total: 9,
      fired7d: 6,
      firing: 0,
      inProgress: 2,
      overdue: 1,
      fireFailed: 1,
      orphaned: 1,
      resolved: { fixed: 3, couldNotFix: 1, needsHuman: 0 },
      fixed7d: 3,
      lastDispatchAt: new Date().toISOString(),
      lastOutcomeAt: new Date().toISOString(),
    };
    improvementsResult = {
      data: [{ ...base, flow: { ...base.flow, dispatch } }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    fireEvent.click(screen.getByRole("button", { name: "Loop diagnostics" }));
    const strip = screen.getByLabelText("Improvement flow (trailing window)");
    expect(strip.textContent).toMatch(/dispatch\s*6\s*fired \/\s*3\s*fixed/);
    expect(strip.textContent).toContain("3 dead"); // overdue + fire-failed + orphaned
    expect(
      strip.querySelectorAll(".pc-learning__flowchip--wd-bad").length,
    ).toBeGreaterThanOrEqual(1);
    // The base fixture carries no dispatch block → the existing flow-strip test
    // doubles as the omitted-chip case.
  });
});

describe("LearningTab — Gym view", () => {
  beforeEach(() => {
    nuqsState.lview = "gym";
  });

  it("leads directly with sparse gym challengers", () => {
    render(<LearningTab />);
    expect(screen.getByText("Prompt gym")).toBeTruthy();
    expect(screen.getByText("Recent challengers")).toBeTruthy();
    expect(document.querySelector(".pc-learning__gymflow")).toBeNull();
    expect(
      screen.getByText("tighten the worker acceptance check"),
    ).toBeTruthy();
    expect(screen.getByText("more explicit chunk sizing")).toBeTruthy();
    // the champion (accepted) proposal's role
    expect(screen.getByText("worker")).toBeTruthy();
  });

  it("renders the gym empty state when no proposals exist", () => {
    gymResult = {
      data: [{ proposals: [], autoloops: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("No gym experiments")).toBeTruthy();
  });
});

describe("LearningTab — unified Signals views", () => {
  it("renders Observations and Rubrics inside Observe", () => {
    nuqsState.lview = "observations";
    render(<LearningTab />);
    expect(screen.getByTestId("observations-panel")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Observe" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Observations" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Rubrics" })).toBeTruthy();
  });

  it("renders Ideas inside Improve", () => {
    nuqsState.lview = "ideas";
    render(<LearningTab />);
    expect(screen.getByText("Routed ideas")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Improve" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("renders Rubrics inside Observe and drills into a rubric", () => {
    nuqsState.lview = "rubrics";
    const { rerender } = render(<LearningTab />);
    expect(screen.getByTestId("rubrics-panel")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Observe" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("rubrics-panel"));
    rerender(<LearningTab />);
    expect(screen.getByTestId("rubrics-panel")).toBeTruthy();
    expect(document.querySelector(".pc-learning__rubricdetail")).not.toBeNull();
    expect(screen.getByTestId("rubric-detail").textContent).toContain(
      "rubric-1",
    );
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByTestId("rubrics-panel")).toBeTruthy();
  });

  it("keeps a visited sync pane mounted when navigating to another stage", () => {
    nuqsState.lview = "ideas";
    const { rerender } = render(<LearningTab />);
    expect(document.querySelector('[data-view="ideas"]')).not.toBeNull();

    nuqsState.lview = "observations";
    rerender(<LearningTab />);
    expect(
      document.querySelector('[data-view="ideas"]')?.hasAttribute("hidden"),
    ).toBe(true);
    expect(
      document
        .querySelector('[data-view="observations"]')
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("bounds warm panes to the current view and two recent views", () => {
    nuqsState.lview = "ideas";
    const { rerender } = render(<LearningTab />);
    for (const next of ["observations", "rubrics", "benchmark"]) {
      nuqsState.lview = next;
      rerender(<LearningTab />);
    }
    expect(document.querySelector('[data-view="ideas"]')).toBeNull();
    expect(document.querySelectorAll(".pc-learning__viewpane")).toHaveLength(3);
    expect(document.querySelector('[data-view="observations"]')).not.toBeNull();
    expect(document.querySelector('[data-view="rubrics"]')).not.toBeNull();
    expect(document.querySelector('[data-view="benchmark"]')).not.toBeNull();
  });

  it("clears transient idea detail when leaving Ideas", () => {
    nuqsState.lview = "ideas";
    nuqsState.grade = "idea-1";
    const { rerender } = render(<LearningTab />);
    nuqsState.lview = "observations";
    rerender(<LearningTab />);
    expect(nuqsSetters.grade).toHaveBeenCalledWith(null);
  });

  it("keeps operational destinations out of the learning header", () => {
    render(<LearningTab />);
    expect(screen.queryByRole("heading", { name: "Learning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Loop health" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Insights" })).toBeNull();
  });
});

describe("LearningTab — Benchmark view", () => {
  beforeEach(() => {
    nuqsState.lview = "benchmark";
  });

  it("renders the benchmark answer-first comparison and generation trend", () => {
    render(<LearningTab />);
    expect(screen.getByText("Recent generations")).toBeTruthy();
    expect(screen.getAllByText("80%").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".pc-learning-visual__hero")).not.toBeNull();
    expect(
      document.querySelector(".pc-learning-visual__comparison"),
    ).not.toBeNull();
    expect(
      document.querySelector(".pc-learning-visual__evidence"),
    ).not.toBeNull();
    // shas + composites appear in the generation rows AND the BenchmarkTrend line (B-12)
    expect(screen.getAllByText("bbb2222").length).toBeGreaterThanOrEqual(1); // latest generation sha
    expect(screen.getAllByText("4.060").length).toBeGreaterThanOrEqual(1); // older generation composite
    expect(screen.getAllByText("5.950").length).toBeGreaterThanOrEqual(1); // latest composite (scoreboard + trend)
    // the trend line itself: one polyline + one dot per scored generation
    const figure = document.querySelector("figure.pc-benchtrend");
    expect(figure).not.toBeNull();
    expect(figure!.querySelectorAll("circle")).toHaveLength(2);
  });

  it("renders the owner-gated empty state when there are no generations", () => {
    apiaryResult = {
      data: [{ instances: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("No benchmark runs")).toBeTruthy();
    expect(screen.queryByText("No pot-eval runs")).toBeNull();
  });

  it("keeps the latest scored generation primary while showing a newer unscored run as pending", () => {
    apiaryResult = {
      data: [
        {
          instances: [
            {
              ...apiarySnapshot.instances[0],
              instanceId: "pending-run",
              codeSha: "pending7",
              totalRuns: 4,
              successfulRuns: 0,
              successRate: 0,
              meanComposite: null,
              meanTimeToGreenSecs: null,
              meanTokens: null,
              escalationRate: null,
            },
            ...apiarySnapshot.instances,
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getAllByText("pending").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/pending7 · 0\/4/)).toBeTruthy();
    expect(screen.getAllByText("5.950").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("first generation")).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Benchmark" })
        .querySelector(".pc-learning__statusmark"),
    ).toBeNull();
  });

  it("promotes every former benchmark section into the Verify tab row", () => {
    render(<LearningTab />);
    expect(screen.getByRole("tab", { name: "Benchmark" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Pot orchestration" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Framework bake-off" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Wake efficiency" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "EKG" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Red Queen" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Experiments" })).toBeTruthy();
  });

  it("renders Pot orchestration as its own Verify view (HE-07)", () => {
    nuqsState.lview = "orchestration";
    hiveEvalResult = {
      data: [
        {
          instances: [
            {
              instanceId: "hev-new",
              codeSha: "ccc3333",
              createdAt: new Date(2_000_000).toISOString(),
              totalRuns: 4,
              scoredRuns: 4,
              meanComposite: 7.2,
              meanEfficiency: 7,
              meanSpeed: 8,
              meanCriticalPathRatio: 1.3,
              outcomeGatePassRate: 1,
              fabricationRate: 0,
            },
            {
              instanceId: "hev-old",
              codeSha: "ddd4444",
              createdAt: new Date(1_000_000).toISOString(),
              totalRuns: 4,
              scoredRuns: 4,
              meanComposite: 5.5,
              meanEfficiency: 6,
              meanSpeed: 6,
              meanCriticalPathRatio: 1.6,
              outcomeGatePassRate: 0.75,
              fabricationRate: 0,
            },
          ],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("Outcome gate")).toBeTruthy();
    expect(screen.getByText("1.30×")).toBeTruthy(); // latest critical-path ratio
    expect(screen.getAllByText("7.200").length).toBeGreaterThanOrEqual(1); // latest composite
    expect(document.querySelectorAll("figure.pc-benchtrend")).toHaveLength(1);
    expect(
      screen.getByRole("tab", { name: "Verify" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: "Observe" })
        .getAttribute("data-complete"),
    ).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "Verify" })
        .querySelector(".pc-learning__statusmark"),
    ).toBeNull();
  });

  it("renders the Pot-eval empty state only in the Pot orchestration view", () => {
    nuqsState.lview = "orchestration";
    render(<LearningTab />);
    expect(screen.getByText("No pot-eval runs")).toBeTruthy();
  });
});

describe("ScoutView (Learning › Improve › Ideas) — routed ideas + tick", () => {
  beforeEach(() => {
    nuqsState.lview = "ideas";
  });

  it("renders the scoreboard, the routed-idea ledger rows, and the last-tick chip", () => {
    render(<ScoutView />);
    // Scoreboard: totalRouted stat + one Stat per rail (labelled via RAIL_META).
    expect(screen.getAllByText("4").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("plan draft").length).toBeGreaterThanOrEqual(1); // rail stat label + ledger row rail label
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
    // The per-item ledger (replaced the by-rail rows): openable rows with
    // title, producing lens, and the classified outcome (pending suppressed).
    expect(screen.getByText("Routed ideas")).toBeTruthy();
    expect(screen.getByText("Cache-warmup plan draft")).toBeTruthy();
    expect(screen.queryByText("Tighter scoper prompt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Reviewed ideas/ }));
    expect(screen.getByText("Tighter scoper prompt")).toBeTruthy();
    expect(screen.getByText("reframing")).toBeTruthy(); // lens chip
    expect(screen.getByText("won")).toBeTruthy(); // classified outcome shown
    expect(screen.queryByText("pending")).toBeNull(); // pending outcome suppressed
    expect(
      screen.getAllByRole("button", { name: /Cache-warmup|Tighter scoper/ })
        .length,
    ).toBe(2); // rows are openable
    const tickChip = screen.getByLabelText("scout tick health");
    expect(tickChip.textContent).toContain("last tick");
    expect(tickChip.textContent).toContain("5m ago");
    expect(tickChip.textContent).toContain("gated · min-interval"); // status + the self-gate that withheld the cycle
  });

  it("renders the graceful empty state when nothing has been routed and no tick exists", () => {
    scoutResult = {
      data: [{ totalRouted: 0, railCounts: [], lastTick: null }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<ScoutView />);
    expect(screen.getByText("No routed ideas")).toBeTruthy();
    expect(screen.getByLabelText("scout tick health").textContent).toContain(
      "none yet",
    );
  });

  it("turns route bars into filters and defaults to an eight-item decision queue", () => {
    const recent = Array.from({ length: 10 }, (_, index) => ({
      ...scoutSnapshot.recent[0],
      ideaId: `queue-${index}`,
      title: `Queue idea ${index + 1}`,
    }));
    scoutResult = {
      data: [
        {
          ...scoutSnapshot,
          totalRouted: 10,
          railCounts: [{ rail: "plan", count: 10 }],
          recent,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    const { rerender } = render(<ScoutView />);
    expect(screen.getAllByText(/Queue idea/)).toHaveLength(8);
    fireEvent.click(
      screen.getByRole("button", { name: /Earlier ungraded ideas/ }),
    );
    expect(screen.getAllByText(/Queue idea/)).toHaveLength(10);
    const planFilter = screen
      .getByLabelText("Idea routing")
      .querySelector("button") as HTMLButtonElement;
    fireEvent.click(planFilter);
    rerender(<ScoutView />);
    expect(
      screen
        .getByLabelText("Idea routing")
        .querySelector("button")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("ScoutView (Learning › Improve › Ideas) — idea grading (B-07, scout-idea-grading-2026-06-12)", () => {
  beforeEach(() => {
    nuqsState.lview = "ideas";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps grading controls behind the selected row and shows attribution at rest", () => {
    const { rerender } = render(<ScoutView />);
    expect(screen.queryByRole("radio", { name: "Grade 3 of 5" })).toBeNull();
    // idea-2 is Queen-graded ★4 in the fixture (gradedBy:'Queen' is the raw server
    // value) → the attribution chip routes it through the lexicon; under the echo
    // mock t('brain') → 'brain' (restore-pot-lexicon P-006).
    fireEvent.click(screen.getByRole("button", { name: /Reviewed ideas/ }));
    expect(screen.getByText("★4 · brain")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Grade this idea" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review idea grade" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Grade this idea" }));
    rerender(<ScoutView />);
    expect(screen.getByRole("radio", { name: "Grade 3 of 5" })).toBeTruthy();
  });

  it("writes a star click through the blender:grade-idea proxy optimistically and invalidates", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ applied: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ScoutView />);
    fireEvent.click(screen.getByRole("button", { name: "Grade this idea" }));
    rerender(<ScoutView />);
    fireEvent.click(screen.getByRole("radio", { name: "Grade 5 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "save grade" }));
    // Optimistic: the row leaves the ungraded queue and joins reviewed history.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Reviewed ideas/ }).textContent,
      ).toContain("2"),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/agent-tools/scout/grade-idea");
    expect(JSON.parse(String(init.body))).toEqual({
      ideaId: "idea-1",
      grade: 5,
    });
    await waitFor(() => expect(scoutResult.invalidate).toHaveBeenCalled());
  });

  it("rolls back the optimistic grade and surfaces the error when the write fails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<ScoutView />);
    fireEvent.click(screen.getByRole("button", { name: "Grade this idea" }));
    rerender(<ScoutView />);
    fireEvent.click(screen.getByRole("radio", { name: "Grade 5 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "save grade" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("HTTP 404"),
    );
    expect(screen.queryByText("★5 · Owner")).toBeNull(); // rolled back to ungraded
  });

  it("opens the note popover from ?grade=<ideaId>, gates save on a grade, and saves grade + note together", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ applied: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    nuqsState.grade = "idea-1";
    render(<ScoutView />);
    const panel = screen
      .getByRole("radio", { name: "Grade 2 of 5" })
      .closest(".pc-learning__gradepanel") as HTMLElement;
    expect(panel).toBeTruthy();
    expect(within(panel).queryByLabelText("Grading note")).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: "save grade" }),
    ).toBeNull();
    fireEvent.click(within(panel).getByRole("radio", { name: "Grade 2 of 5" }));
    fireEvent.change(within(panel).getByLabelText("Grading note"), {
      target: { value: "Too speculative" },
    });
    const save = within(panel).getByRole("button", {
      name: "save grade",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({
      ideaId: "idea-1",
      grade: 2,
      feedback: "Too speculative",
    });
  });

  it("renders the lens-weight strip as shares sorted descending, hidden when absent", () => {
    // Default fixture carries no lensWeights → no strip.
    render(<ScoutView />);
    expect(screen.queryByLabelText("Lens sampling weights")).toBeNull();
    cleanup();
    scoutResult = {
      data: [
        { ...scoutSnapshot, lensWeights: { reframing: 3, analogical: 1 } },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<ScoutView />);
    fireEvent.click(screen.getByRole("button", { name: /Lens weights/ }));
    const strip = screen.getByLabelText("Lens sampling weights");
    expect(strip.textContent).toContain("lens weights");
    expect(strip.textContent).toContain("75%");
    expect(strip.textContent).toContain("25%");
    // Sorted descending: reframing (75%) before analogical (25%).
    expect(strip.textContent!.indexOf("reframing")).toBeLessThan(
      strip.textContent!.indexOf("analogical"),
    );
  });
});

describe("LearningTab — per-Hive lens (per-hive-learning-loops-2026-06-14 P-042)", () => {
  it("renders the tab-level hive picker on hive-aware views (Improvements) with the hiveList options", () => {
    render(<LearningTab />); // default view = improvements (hive-aware)
    const picker = screen.getByLabelText("pot lens") as HTMLSelectElement;
    expect(picker).toBeTruthy();
    // Labels are the friendly hive name — hiveHomeLabel strips the `-hive` home
    // suffix for display (workspace-hive-ui-2026-06-17) — while the option VALUE
    // stays the raw slug for backend calls.
    const alpha = within(picker).getByRole("option", {
      name: "alpha",
    }) as HTMLOptionElement;
    expect(alpha.value).toBe("alpha-hive");
    // remote hives are badged "(joined)".
    const beta = within(picker).getByRole("option", {
      name: "beta (joined)",
    }) as HTMLOptionElement;
    expect(beta.value).toBe("beta-hive");
  });

  it("shows the picker on the Gym and Learnings views too", () => {
    nuqsState.lview = "gym";
    const { rerender } = render(<LearningTab />);
    expect(screen.getByLabelText("pot lens")).toBeTruthy();
    cleanup();
    nuqsState.lview = "learnings";
    render(<LearningTab />);
    expect(screen.getByLabelText("pot lens")).toBeTruthy();
  });

  it("HIDES the picker on workspace-global views", () => {
    for (const v of [
      "observations",
      "ideas",
      "rubrics",
      "benchmark",
      "throughput",
    ]) {
      cleanup();
      nuqsState.lview = v;
      render(<LearningTab />);
      expect(screen.queryByLabelText("pot lens")).toBeNull();
    }
  });

  it("defaults the selection to the first hive and scopes the feed to it (consistent per-Hive lens)", () => {
    // lhive='' → the resolved hive falls back to the first list entry, and EVERY
    // hive-aware view scopes to that concrete hive (matches what the Learnings
    // view already did). The picker value + the threaded arg agree, so the lens
    // is never silently workspace-wide while showing a specific hive selected.
    render(<LearningTab />);
    const picker = screen.getByLabelText("pot lens") as HTMLSelectElement;
    expect(picker.value).toBe("alpha-hive"); // first hive shown as the selection
    expect(seenArgs["learning.improvements"]).toEqual({ hive: "alpha-hive" });
  });

  it("defaults to the current harness when it is a selectable pot", () => {
    nuqsState.slug = "beta-hive";
    render(<LearningTab />);
    expect((screen.getByLabelText("pot lens") as HTMLSelectElement).value).toBe(
      "beta-hive",
    );
    expect(seenArgs["learning.improvements"]).toEqual({ hive: "beta-hive" });
  });

  it("threads the chosen hive into the Improvements query args", () => {
    nuqsState.lhive = "beta-hive";
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toEqual({ hive: "beta-hive" });
  });

  it("threads the chosen hive into the Gym query args", () => {
    nuqsState.lview = "gym";
    nuqsState.lhive = "beta-hive";
    render(<LearningTab />);
    expect(seenArgs["learning.gym"]).toEqual({ hive: "beta-hive" });
  });

  it("threads the chosen hive into the Learnings (learning.hive) query args", () => {
    nuqsState.lview = "learnings";
    nuqsState.lhive = "beta-hive";
    render(<LearningTab />);
    expect(seenArgs["learning.hive"]).toEqual({ hive: "beta-hive" });
  });

  it("turns retained prose into a headline preview with typed provenance", () => {
    nuqsState.lview = "learnings";
    hiveResult = {
      data: [
        {
          hive: "alpha-hive",
          rows: [
            {
              id: "learning-1",
              text: "Migration 557 completed the canonical federation table rename. Live code now uses pot-prefixed tables everywhere.",
              kind: "migration",
              createdBy: "system-migration",
            },
          ],
          packs: [],
          organicCount: 1,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    const { rerender } = render(<LearningTab />);
    const summary = document.querySelector(".pc-learning__retainedsummary")!;
    expect(summary.querySelector("strong")?.textContent).toBe(
      "Migration 557 completed the canonical federation table rename.",
    );
    expect(summary.textContent).toContain("Live code now uses");
    expect(
      document.querySelector(".pc-learning__provenance.is-system"),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open learning Migration 557 completed/,
      }),
    );
    expect(nuqsSetters.lretain).toHaveBeenCalledWith("learning-1");
    nuqsState.lretain = "learning-1";
    rerender(<LearningTab />);
    expect(screen.getByLabelText("Selected learning")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close selected learning" }),
    ).toBeTruthy();
  });

  it("pins a deep-linked earlier learning into the visible Retain index", () => {
    nuqsState.lview = "learnings";
    nuqsState.lretain = "learning-8";
    hiveResult = {
      data: [
        {
          hive: "alpha-hive",
          rows: Array.from({ length: 8 }, (_, index) => ({
            id: `learning-${index + 1}`,
            text: `Learning ${index + 1}. Supporting detail.`,
            kind: "fact",
            createdBy: "owner",
          })),
          packs: [],
          organicCount: 8,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(
      screen.getByRole("button", { name: /Close learning Learning 8/ }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Selected learning")).toBeTruthy();
  });

  it("filters retained learnings through the compact search affordance", () => {
    nuqsState.lview = "learnings";
    hiveResult = {
      data: [
        {
          hive: "alpha-hive",
          rows: [
            { id: "a", text: "Alpha memory.", kind: "fact", createdBy: "owner" },
            { id: "b", text: "Beta memory.", kind: "fact", createdBy: "owner" },
          ],
          packs: [],
          organicCount: 2,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    fireEvent.click(screen.getByRole("button", { name: "Search learnings" }));
    fireEvent.change(screen.getByLabelText("Search retained learnings"), {
      target: { value: "beta" },
    });
    expect(screen.getByText("Beta memory.")).toBeTruthy();
    expect(screen.queryByText("Alpha memory.")).toBeNull();
  });

  it("writes ?lhive when the picker changes", () => {
    render(<LearningTab />);
    fireEvent.change(screen.getByLabelText("pot lens"), {
      target: { value: "beta-hive" },
    });
    expect(nuqsSetters.lhive).toHaveBeenCalledWith("beta-hive");
  });

  it("disables the picker (no hives yet) and queries improvements workspace-wide", () => {
    hiveListResult = {
      data: [],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    const picker = screen.getByLabelText("pot lens") as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
    expect(
      within(picker).getByRole("option", { name: "no pot yet" }),
    ).toBeTruthy();
    expect(seenArgs["learning.improvements"]).toEqual({});
  });
});
