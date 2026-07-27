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

// P-009: this vitest env exposes Node's built-in localStorage (method-less
// without --localstorage-file — see libs/test-config/src/index.ts's note), not
// jsdom's. Install a real in-memory Storage so the orientation-banner
// persistence path is actually exercised.
const memStorage: Storage = (() => {
  let bag: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in bag ? bag[k] : null),
    setItem: (k: string, v: string) => {
      bag[k] = String(v);
    },
    removeItem: (k: string) => {
      delete bag[k];
    },
    clear: () => {
      bag = {};
    },
    key: () => null,
    get length() {
      return Object.keys(bag).length;
    },
  } as Storage;
})();
Object.defineProperty(window, "localStorage", {
  value: memStorage,
  configurable: true,
});

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
  // P-009: useOpenArming + the orientation banner write the LeftSidebar rail
  // keys (`lsb`/`lst`) as ONE group — mirror useQueryState over the same
  // nuqsState bag so a click's write is observable via nuqsState.
  useQueryStates: (spec: Record<string, unknown>) => {
    const setter = (nuqsSetters.__rail ??= vi.fn(
      (patch: Record<string, unknown>) => {
        Object.assign(nuqsState, patch);
      },
    ));
    const value: Record<string, unknown> = {};
    for (const key of Object.keys(spec)) value[key] = nuqsState[key] ?? null;
    return [value, setter];
  },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsString: { withDefault: () => ({}) },
  parseAsBoolean: { withDefault: () => ({}) },
}));

// The pot lens is INHERITED from the top-bar selector via useAdvScope (owner
// directive 2026-07-26 — the tab's own ?lhive= picker is gone). Tests drive the
// lens by mutating this bag; beforeEach resets it to the alpha-hive default the
// old first-list-entry fallback used, so scoping expectations read the same.
const advScopeState = { allMode: false, slug: "alpha-hive" as string | null, hive: "alpha-hive", ready: true };
vi.mock("./AdvShell", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./AdvShell")>();
  return { ...orig, useAdvScope: () => ({ ...advScopeState }) };
});

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
// The shared column-filter layer (Work-Queue parity, owner ask 2026-07-19) is
// covered by the filters lib's own suite; stub it to a pass-through so these
// tests exercise the view's OWN quick-search / lane / source logic.
vi.mock("@/app/harness/filters", () => ({
  useColumnFilters: <T,>(_cols: unknown, rows: readonly T[]) => ({
    rows,
    controller: null,
    activeChips: [],
    hasActive: false,
    clearAll: () => {},
  }),
  ColumnFilterBar: () => null,
}));

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
      // P-004 trace fields: grounded in one opaque wi: ref (title resolved via
      // groundingTitles below) + one readable typed ref.
      origin: "scout",
      cycleId: "scout-100",
      addressesPatternRefs: ["wi:EI-100", "fact:workspace:some-standing-fact"],
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
      origin: "scout",
      cycleId: "scout-99",
      addressesPatternRefs: [],
    },
  ],
  lastTick: {
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    outcome: "gated",
    detail: "min-interval",
  },
  // P-002 tick-economics strip (newest first) + P-003 server-evaluated health.
  ticks: [
    {
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      status: "gated",
      stop: "min-interval",
      generated: 0,
      routed: 0,
      deduped: 0,
      spendUsd: null,
      cycleId: null,
      lenses: {},
    },
    {
      at: new Date(Date.now() - 35 * 60_000).toISOString(),
      status: "ran",
      stop: "completed",
      generated: 8,
      routed: 3,
      deduped: 2,
      spendUsd: 1.62,
      cycleId: "scout-100",
      lenses: { reframing: 2, analogical: 1 },
    },
  ],
  health: { status: "good", markers: [] },
  // P-004: server-resolved titles for the opaque wi: grounding refs.
  groundingTitles: { "wi:EI-100": "coord invariant: wake-queue depth growth" },
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
// reads learning.hive + knowledgePacks.list. Defaults: two hives so the picker
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
// When set, a hive-less (`{}`) learning.gym read returns THIS instead of
// gymResult — lets a test model the client's scoped→workspace-wide fallback.
let gymWideResult: Record<string, unknown> | null = null;
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: {
    queryName: string;
    args?: unknown;
    enabled?: boolean;
  }) => {
    // Only record ACTUALLY-firing queries — a hook gated `enabled: false` (e.g.
    // the gym view's workspace-wide fallback when the scoped read has data) does
    // not fetch, so it must not clobber the recorded args of the real read.
    if (opts.enabled !== false) seenArgs[opts.queryName] = opts.args;
    if (opts.queryName === "learning.gym") {
      const hasHive = Boolean((opts.args as { hive?: string } | undefined)?.hive);
      return !hasHive && gymWideResult ? gymWideResult : gymResult;
    }
    if (opts.queryName === "learning.scoutDrafts") {
      // The Improvements view's thin drafts read — empty by default.
      return { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    }
    return opts.queryName === "learning.apiary"
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
                  : opts.queryName === "learning.retain"
                    ? {
                        data: [
                          {
                            banked: { improvementsFiled7d: 5, plansDrafted7d: 2 },
                            lensWeights: null,
                            rubricChanges: [],
                            insightDocs: [],
                            recipes: [],
                            generatedAt: "2026-07-19T00:00:00.000Z",
                          },
                        ],
                        loading: false,
                        fetching: false,
                        error: null,
                        invalidate: vi.fn(),
                      }
                  : opts.queryName === "knowledgePacks.list" ||
                      opts.queryName === "knowledgePacks.candidates"
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

import { setFlagPayload } from "@papercusp/flags/client";
import { FLAGS } from "@papercusp/flags";
import LearningTab, {
  ARMING_AGENTS_LANE,
  ARMING_SIDEBAR_TAB,
  ScoutView,
} from "./LearningTab";

beforeEach(() => {
  nuqsState.lview = "improvements";
  nuqsState.lane = "all";
  nuqsState.tab = null;
  nuqsState.grade = null;
  nuqsState.irail = null;
  nuqsState.itrace = null;
  nuqsState.rrubric = null;
  nuqsState.lretain = null;
  nuqsState.slug = null;
  advScopeState.allMode = false;
  advScopeState.slug = "alpha-hive";
  advScopeState.hive = "alpha-hive";
  advScopeState.ready = true;
  // P-009 rail keys (useOpenArming / the orientation banner write these).
  nuqsState.lsb = null;
  nuqsState.lst = null;
  window.localStorage.removeItem("pc-learning-orientation-dismissed");
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
  gymWideResult = null;
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
    expect(screen.getByRole("tab", { name: /Backlog/ })).toBeTruthy();
    expect(screen.getByText("135")).toBeTruthy(); // captured (stat line)
    // open now rides the quiet header signal ("117 open") rather than a standalone
    // hero number (owner ask 2026-07-19: header pill + metric tiles → one stat line).
    expect(screen.getByText(/117\s+open/)).toBeTruthy(); // open (header signal)
    expect(screen.getByText("15")).toBeTruthy(); // resolved (stat line)
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

  it("filters the backlog through the quick-search box, Work-Queue style (owner ask 2026-07-19)", () => {
    nuqsState.impq = "massacre";
    render(<LearningTab />);
    expect(screen.getByLabelText("Search improvements")).toBeTruthy();
    expect(
      screen.getByText("Peer restarts massacre in-flight spawns"),
    ).toBeTruthy();
    expect(
      screen.queryByText("cup:spawn children are coordination-MUTE"),
    ).toBeNull();
    // The match count reads shown-of-total while a search is active.
    expect(screen.getByText("1 of 2")).toBeTruthy();
    nuqsState.impq = "";
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
    // Gym is NOT here by default any more: it rides FLAGS.TESTING (default off)
    // because it is not public-release ready [owner 2026-07-27]. The flag-ON
    // case is the next test.
    expect(screen.queryByRole("tab", { name: "Gym" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Backlog/ })).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Improve" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  /** The Gym gate (WI-6315) [owner 2026-07-27: "Put all the gym features behind a
   *  testing flag, it isnt ready at all"]. Both directions are pinned: hiding it
   *  by default is the release requirement, and the flag-ON path must still be
   *  the full tab — a gate that silently deleted the view would be a different
   *  bug from the one being fixed. The deep-link case matters because `?lview=`
   *  is bookmarkable and appears in reports, so a stale gym link must LAND
   *  somewhere real rather than render a pane the tab no longer offers. */
  describe("Gym view gating (FLAGS.TESTING)", () => {
    afterEach(() => {
      setFlagPayload({ flags: {}, evaluatedAt: new Date().toISOString() });
    });

    it("shows the Gym view when FLAGS.TESTING is on", () => {
      setFlagPayload({
        flags: { [FLAGS.TESTING]: true },
        evaluatedAt: new Date().toISOString(),
      });
      render(<LearningTab />);
      expect(screen.getByRole("tab", { name: "Gym" })).toBeTruthy();
    });

    it("redirects a stale ?lview=gym deep-link to the default view when the flag is off", () => {
      nuqsState.lview = "gym";
      render(<LearningTab />);
      expect(screen.queryByRole("tab", { name: "Gym" })).toBeNull();
      // Landed on Improve → Backlog (the default), not an empty pane.
      expect(
        screen.getByRole("tab", { name: "Improve" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByRole("tab", { name: /Backlog/ })).toBeTruthy();
    });
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
      document.querySelector(".pc-learning-visual__statline"),
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
    // Loop diagnostics live behind the "How the capture loop is doing"
    // disclosure (owner ask 2026-07-19b) — open it first.
    fireEvent.click(
      screen.getByRole("button", { name: /How the capture loop is doing/ }),
    );
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
    // Loop diagnostics always visible (owner ask 2026-07-19) — no disclosure to open.
    expect(
      screen.queryByLabelText("Improvement flow (trailing window)"),
    ).toBeNull();
    expect(screen.getByText("135")).toBeTruthy(); // the stat line still renders
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
    // Loop diagnostics live behind the "How the capture loop is doing"
    // disclosure (owner ask 2026-07-19b) — open it first.
    fireEvent.click(
      screen.getByRole("button", { name: /How the capture loop is doing/ }),
    );
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
    // the champion (accepted) proposal's role — on the deck badge AND the row
    expect(screen.getAllByText("worker").length).toBeGreaterThanOrEqual(1);
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
    // WI-5809: the empty state NAMES the selected pot (lhive='' resolves to the
    // first list entry) rather than claiming to speak for the whole workspace.
    expect(screen.getByText("No gym activity for alpha-hive yet")).toBeTruthy();
    // P-009 teaching empty: body copy + the arming action ride the same state.
    expect(screen.getByText(/A\/B-refine their blueprints/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Arm the Gym" })).toBeTruthy();
  });

  // WI-5809 (owner report 2026-07-25): NO CROSS-TENANT FALLBACK. This used to
  // assert the opposite — that an empty pot-scoped read fell back to the
  // workspace-wide rollup. That fallback is how selecting Oddsmith rendered
  // PAPERCUSP's gym experiments, so it was removed from BOTH the server
  // (`learning.gym` resolver) and this view. A selected pot now shows only its
  // own data, or an honest empty state naming it.
  it("does NOT fall back to the workspace-wide rollup when the pot-scoped read is empty (WI-5809 — no cross-tenant leak)", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    // The `papercusp` pot: 1 autoloop config, 0 proposals, 0 archiveSeeds.
    gymResult = {
      data: [
        {
          proposals: [],
          autoloops: [
            { harnessSlug: "papercusp", enabled: false, status: "idle", spentUsd: 0 },
          ],
          archiveSeeds: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    // The workspace-wide read (hive-less args) DOES have experiments — and the
    // view must still NOT reach for them.
    gymWideResult = {
      data: [
        {
          proposals: [{ id: "wp1", status: "pending" }],
          autoloops: [],
          archiveSeeds: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    // The honest, pot-named empty state — not another tenant's challengers.
    expect(screen.getByText("No gym activity for papercusp yet")).toBeTruthy();
    expect(screen.queryByText("Recent challengers")).toBeNull();
    // The gym read stays scoped to the selected pot: no second hive-less fetch.
    expect(seenArgs["learning.gym"]).toEqual({ hive: "papercusp" });
  });

  it("shows loading — NOT the empty state — before the gym query has resolved (undefined snapshot)", () => {
    // Regression (owner report 2026-07-19): a not-yet-fetched gym query (snap
    // undefined, e.g. while the hive lens is still resolving so `enabled` is
    // false) must read as loading. It previously fell through to "No gym
    // experiments" even though the workspace had proposals server-side.
    gymResult = {
      data: undefined,
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("Loading gym experiments…")).toBeTruthy();
    // Match the CURRENT empty-state copy ("No gym activity …"); the old
    // /No gym experiments/ regex silently stopped matching anything.
    expect(screen.queryByText(/No gym activity/)).toBeNull();
  });

  // WI-5420 flagged `scopeFallback: true` when the server fell back to the
  // workspace-wide rollup, and this view rendered a note disclosing it. WI-5809
  // deleted the fallback itself — showing tenant A's rows under tenant B's lens
  // is a correctness bug that a disclosure note does not make correct — so the
  // server never sets the flag any more. A legacy/cached payload that still
  // carries it must render as ordinary scoped data, with no cross-tenant note.
  it("renders a legacy scopeFallback payload as ordinary scoped data — no cross-tenant note (WI-5809)", () => {
    gymResult = {
      data: [{ proposals: [{ id: "p1", status: "pending" }], autoloops: [], scopeFallback: true }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(screen.getByText("Recent challengers")).toBeTruthy();
    expect(screen.queryByText(/none are scoped to this pot yet/)).toBeNull();
    expect(screen.queryByText(/Showing gym experiments from all/)).toBeNull();
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
    // P-006: the compare-view leads with the question it answers.
    expect(screen.getByText("Did the new build get better?")).toBeTruthy();
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
    expect(
      document.querySelector(".pc-learning__pendinginline")?.textContent,
    ).toContain("pending · 0/4");
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
    // P-006: the view shows hive-eval SCORING trends, so the label says so.
    expect(screen.getByRole("tab", { name: "Pot scoring" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Framework bake-off" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Wake efficiency" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "EKG" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Red Queen" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Experiments" })).toBeTruthy();
  });

  it("renders Pot scoring (né Pot orchestration) as its own Verify view (HE-07)", () => {
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
    // P-006: leads with the question the scoring trend answers.
    expect(screen.getByText("Are orchestration scores improving?")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: /Graded ideas/ }));
    expect(screen.getByText("Tighter scoper prompt")).toBeTruthy();
    // "reframing" appears on the stack's lens badge AND in the card's
    // always-visible trace lens stage.
    expect(screen.getAllByText("reframing").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("won")).toBeTruthy(); // classified outcome shown
    // The card-head outcome chip still SUPPRESSES pending (the trace's outcome
    // stage is where "pending" legitimately shows).
    expect(
      [...document.querySelectorAll(".pc-learning__score")].some(
        (el) => el.textContent === "pending",
      ),
    ).toBe(false);
    expect(
      screen.getAllByRole("button", { name: /Cache-warmup|Tighter scoper/ })
        .length,
    ).toBe(2); // rows are openable
    // P-002 strip: the instruments now live behind the "How the cycle engine
    // is doing" disclosure (owner ask 2026-07-19b — plain glance line up top,
    // gauges on demand). Open it, then assert the tick economics.
    fireEvent.click(
      screen.getByRole("button", { name: /How the cycle engine is doing/ }),
    );
    const strip = screen.getByLabelText("scout tick economics, newest first");
    expect(strip.textContent).toContain("min-interval");
    expect(strip.textContent).toContain("8→3");
    expect(strip.textContent).toContain("completed");
    expect(strip.textContent).toContain("$1.62");
  });

  it("renders the graceful empty state when nothing has been routed and no tick exists (legacy pre-P-002 payload shape)", () => {
    scoutResult = {
      data: [{ totalRouted: 0, railCounts: [], lastTick: null }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<ScoutView />);
    // P-009 teaching empty: title + body + the one arming action.
    expect(screen.getByText("No routed ideas yet")).toBeTruthy();
    expect(screen.getByText(/routes surviving ideas here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Arming" }));
    expect(nuqsState.lsb).toBe(true);
    // MUST be a live LeftSidebar tab id — 'blender' was retired, which silently
    // turned this button into a no-op (see ARMING_SIDEBAR_TAB).
    expect(nuqsState.lst).toBe("agents");
    fireEvent.click(
      screen.getByRole("button", { name: /How the cycle engine is doing/ }),
    );
    expect(
      screen.getByLabelText("scout tick economics, newest first").textContent,
    ).toContain("none yet");
  });

  it("shows an ungraded card's FULL pipeline trace inline — no click-to-reveal (owner ask 2026-07-19)", () => {
    render(<ScoutView />);
    const trace = screen.getByLabelText(
      "Pipeline trace for Cache-warmup plan draft",
    );
    // Grounding: a RESOLVED wi: ref shows its title alone (the raw id lives in
    // the tooltip — owner ask 2026-07-19e); the readable typed ref renders as-is.
    expect(trace.textContent).toContain(
      "coord invariant: wake-queue depth growth",
    );
    expect(trace.textContent).not.toContain("EI-100 ·");
    expect(trace.textContent).toContain("workspace:some-standing-fact");
    // Lens + origin, the routed artifact, the grade GAP, and the outcome.
    expect(trace.textContent).toContain("reframing");
    expect(trace.textContent).toContain("scout");
    // The routed chip shows rail label + prefix-stripped ref ("plan draft ·
    // scout-cache-warmup"), never the doubled "plan: plan:…" form.
    expect(trace.textContent).toContain("scout-cache-warmup");
    expect(trace.textContent).not.toContain("plan:scout-cache-warmup");
    expect(trace.textContent).toContain("ungraded"); // the gap IS the signal
    expect(trace.textContent).toContain("pending");
    // The card TITLE deep-links to the routed artifact (a plan → Create tab).
    fireEvent.click(
      screen.getByRole("button", { name: "Cache-warmup plan draft" }),
    );
    expect(nuqsSetters.plan).toHaveBeenCalledWith("scout-cache-warmup");
    expect(nuqsSetters.view).toHaveBeenCalledWith("plans");
    expect(nuqsSetters.tab).toHaveBeenCalledWith("plans");
  });

  it("renders the trace's grounding gap dimmed when no refs were recorded (P-004)", () => {
    nuqsState.itrace = "idea-2";
    render(<ScoutView />);
    fireEvent.click(screen.getByRole("button", { name: /Graded ideas/ }));
    const trace = screen.getByLabelText(
      "Pipeline trace for Tighter scoper prompt",
    );
    expect(trace.textContent).toContain("none recorded");
    expect(trace.textContent).toContain("★4 · brain"); // graded stage filled (t('brain') echoes)
    expect(trace.textContent).toContain("won");
  });

  it("splits ungraded ideas into an 8-item decision queue + an 'earlier' disclosure, each as per-lens overlapping stacks", () => {
    // 10 ungraded ideas, all one lens → one stack in the decision queue (top
    // card visible, 8 total) and one stack of the remaining 2 behind the
    // "Earlier ungraded ideas" disclosure (owner ask 2026-07-19 — the cards
    // OVERLAP, so only the top of each stack shows its title at a time).
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
    // Decision queue: one lens stack. The active card is live; the stacked
    // cards behind it are mounted (their content is what makes the deck
    // animation seamless) but aria-hidden + inert.
    expect(
      screen.getByText("Queue idea 1").closest('[aria-hidden="true"]'),
    ).toBeNull();
    expect(
      screen.getByText("Queue idea 2").closest('[aria-hidden="true"]'),
    ).toBeTruthy();
    // The stack holds 8 (of 10; the other 2 are "earlier") → 8 position dots,
    // the last labelled "8 of 8".
    expect(screen.getByLabelText("Go to card 8 of 8")).toBeTruthy();
    // Step the deck: the next idea becomes the live top card.
    fireEvent.click(screen.getAllByRole("button", { name: "Next card" })[0]);
    expect(
      screen.getByText("Queue idea 2").closest('[aria-hidden="true"]'),
    ).toBeNull();
    // The remaining 2 live behind the "Earlier ungraded ideas" disclosure.
    fireEvent.click(
      screen.getByRole("button", { name: /Earlier ungraded ideas/ }),
    );
    expect(screen.getByText("Queue idea 9")).toBeTruthy();
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

  it("shows the inline star grader ON the ungraded card, and attribution on graded rows", () => {
    render(<ScoutView />);
    // The star grader lives on the card itself now (owner ask 2026-07-19d) —
    // five radios, visible at rest, no popup to open.
    expect(screen.getByRole("radio", { name: "Grade 3 of 5" })).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Grade this idea" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/ungraded — a grade teaches the generator/),
    ).toBeTruthy();
    // idea-2 is Queen-graded ★4 in the fixture (gradedBy:'Queen' is the raw server
    // value) → the graded ROW keeps its attribution chip + popover affordance.
    fireEvent.click(screen.getByRole("button", { name: /Graded ideas/ }));
    expect(screen.getByText("★4 · brain")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review idea grade" }),
    ).toBeTruthy();
  });

  it("writes a star click through the blender:grade-idea proxy optimistically and invalidates", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ applied: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ScoutView />);
    // Clicking a star on the card grades IMMEDIATELY (no popup, no save step).
    fireEvent.click(screen.getByRole("radio", { name: "Grade 5 of 5" }));
    // Optimistic: the row leaves the ungraded queue and joins reviewed history.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Graded ideas/ }).textContent,
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
    render(<ScoutView />);
    fireEvent.click(screen.getByRole("radio", { name: "Grade 5 of 5" }));
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
    // ?grade=<ideaId> opens the card's INLINE note editor (no popup). Save is
    // disabled until a star is picked; a star picked while the editor is open
    // waits for Save so grade + note submit together.
    const panel = screen
      .getByRole("radio", { name: "Grade 2 of 5" })
      .closest(".pc-learning__stargrade") as HTMLElement;
    expect(panel).toBeTruthy();
    const save0 = within(panel).getByRole("button", {
      name: "save grade",
    }) as HTMLButtonElement;
    expect(save0.disabled).toBe(true);
    fireEvent.click(within(panel).getByRole("radio", { name: "Grade 2 of 5" }));
    fireEvent.change(within(panel).getByLabelText("Grade feedback"), {
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
    // Always visible under a standard header — no disclosure to open
    // (owner ask 2026-07-19).
    expect(screen.getByText("Lens weights")).toBeTruthy();
    expect(
      screen.getByText(/the ideator's learned creative-lens steering/),
    ).toBeTruthy();
    const strip = screen.getByLabelText("Lens sampling weights");
    expect(strip.textContent).toContain("75%");
    expect(strip.textContent).toContain("25%");
    // Sorted descending: reframing (75%) before analogical (25%).
    expect(strip.textContent!.indexOf("reframing")).toBeLessThan(
      strip.textContent!.indexOf("analogical"),
    );
  });
});

describe("LearningTab — inherited pot lens (owner directive 2026-07-26; was P-042's per-tab picker)", () => {
  const badge = () => document.querySelector(".pc-learning__hivepick");

  it("shows the inherited-pot badge on hive-aware views (Improvements), named via hiveHomeLabel", () => {
    render(<LearningTab />); // default view = improvements (hive-aware)
    // hiveHomeLabel strips the `-hive` home suffix for display
    // (workspace-hive-ui-2026-06-17); the badge is read-only — the selection
    // lives in the top-bar pot selector, not here.
    expect(badge()?.textContent).toContain("alpha");
    expect(document.querySelector("select[aria-label='pot lens']")).toBeNull();
  });

  it("shows the badge on the Gym and Learnings views too", () => {
    nuqsState.lview = "gym";
    render(<LearningTab />);
    expect(badge()).toBeTruthy();
    cleanup();
    nuqsState.lview = "learnings";
    render(<LearningTab />);
    expect(badge()).toBeTruthy();
  });

  it("HIDES the badge on workspace-global views", () => {
    // P-005 (pot-scope-all-learnings): ideas/frontier/throughput joined the
    // hive-aware set — only views whose tables carry no pot identity stay here.
    for (const v of ["observations", "rubrics", "benchmark", "signals"]) {
      cleanup();
      nuqsState.lview = v;
      render(<LearningTab />);
      expect(badge()).toBeNull();
    }
  });

  it("shows the badge on the P-005 pot-scoped views (ideas / frontier / throughput)", () => {
    for (const v of ["ideas", "frontier", "throughput"]) {
      cleanup();
      nuqsState.lview = v;
      render(<LearningTab />);
      expect(badge()).toBeTruthy();
    }
  });

  it("scopes the feed to the inherited pot — badge and threaded arg agree", () => {
    render(<LearningTab />);
    expect(badge()?.textContent).toContain("alpha");
    expect(seenArgs["learning.improvements"]).toEqual({ hive: "alpha-hive" });
  });

  // The lens is inherited from the top-bar pot selection (useAdvScope, owner
  // directive 2026-07-26) — the tab-level picker is gone, so the threading
  // tests drive the SCOPE, exactly as AdvShell resolves it from ?slug=.
  it("threads the inherited pot into the Improvements query args", () => {
    advScopeState.slug = "beta-hive";
    advScopeState.hive = "beta-hive";
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toEqual({ hive: "beta-hive" });
  });

  it("threads the inherited pot into the Gym query args", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "beta-hive";
    advScopeState.hive = "beta-hive";
    gymResult = {
      data: [{ proposals: [{ id: "p1", status: "pending" }], autoloops: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(seenArgs["learning.gym"]).toEqual({ hive: "beta-hive" });
  });

  it("threads the inherited pot into the Learnings (learning.hive) query args", () => {
    nuqsState.lview = "learnings";
    advScopeState.slug = "beta-hive";
    advScopeState.hive = "beta-hive";
    render(<LearningTab />);
    expect(seenArgs["learning.hive"]).toEqual({ hive: "beta-hive" });
  });

  it("All Pots (hive '') scopes every hive-aware query workspace-wide", () => {
    advScopeState.allMode = true;
    advScopeState.slug = null;
    advScopeState.hive = "";
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toEqual({});
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
            {
              id: "a",
              text: "Alpha memory.",
              kind: "fact",
              createdBy: "owner",
            },
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

  it("gates hive-aware queries until the inherited scope is resolved (WI-5412 first-fetch perf)", () => {
    // scope not ready (projects list still loading) → the heavy improvements
    // read must not fire with a half-resolved lens.
    advScopeState.ready = false;
    render(<LearningTab />);
    expect(seenArgs["learning.improvements"]).toBeUndefined();
  });
});

// P-009 (learning-tab-first-run-ux-plan, owner-reviewed 2026-07-26): the
// once-per-workspace orientation banner, its arming deep-link, and the visible
// view gloss (strap).
describe("LearningTab — P-009 first-run orientation", () => {
  it("shows the banner on first run; dismissal persists (once per workspace)", () => {
    render(<LearningTab />);
    expect(screen.getByText(/learns as you work/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/learns as you work/)).toBeNull();
    expect(
      window.localStorage.getItem("pc-learning-orientation-dismissed"),
    ).toBe("1");
    cleanup();
    // A remount (same workspace) must NOT re-show it.
    render(<LearningTab />);
    expect(screen.queryByText(/learns as you work/)).toBeNull();
  });

  it("the banner's Open Arming deep-links the rail to the LIVE Arming tab (agents), not the retired blender id", () => {
    render(<LearningTab />);
    fireEvent.click(screen.getByRole("button", { name: "Open Arming" }));
    expect(nuqsState.lsb).toBe(true);
    expect(nuqsState.lst).toBe(ARMING_SIDEBAR_TAB);
    expect(nuqsState.lst).toBe("agents"); // pinned: a non-TAB_IDS value is silently dropped
    expect(nuqsState.qAgents).toBe(ARMING_AGENTS_LANE); // lands on the Arming lane
  });

  it("renders the visible view gloss for the active view (same source as the tab tooltips)", () => {
    render(<LearningTab />);
    const strap = document.querySelector(".pc-learning__strap");
    expect(strap?.textContent).toContain("WORK queue");
  });
});

/**
 * Owner escalation 2026-07-26 (~20 reports of "no recent gym runs"): the runs
 * list is newest-first at the top of a scrolling pane and the judge cards are
 * below it, so scrolling to read a card pushes every recent run off-screen and
 * the list appears to start hours ago. The runs header is therefore STICKY and
 * carries the newest run's age, so recency is legible at any scroll position.
 */
describe("GymView — recent-challengers header carries recency", () => {
  it("stamps the newest run age + count into a sticky header", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    const now = Date.now();
    gymResult = {
      data: [
        {
          proposals: [],
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          runs: [
            {
              harnessSlug: "papercusp",
              variantId: "cand-newest",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 3 * 3600_000,
              finishedAt: now - 2 * 3600_000, // newest
              decision: null,
              isBaseline: false,
            },
            {
              harnessSlug: "papercusp",
              variantId: "cand-older",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 10 * 3600_000,
              finishedAt: now - 9 * 3600_000,
              decision: null,
              isBaseline: false,
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

    const head = document.querySelector(".pc-learning__sectionhead--stickyruns");
    expect(head).toBeTruthy(); // the header must be the sticky variant
    const recency = head?.querySelector(".pc-learning__runsrecency");
    expect(recency).toBeTruthy();
    // Derived from the NEWEST run (2h), never the oldest (9h), and states the count.
    expect(recency?.textContent).toContain("2h");
    expect(recency?.textContent).not.toContain("9h");
    expect(recency?.textContent).toContain("2 listed");
  });

  /**
   * Owner ask 2026-07-27 ("why isn't RECENT CHALLENGERS just cards like the other
   * section?"): the compact lines duplicated the proposal cards (measured 15 of 17
   * overlapping) because WI-5696's promised dedupe was never written, and the cards
   * were a 1-of-N carousel so the lines were silently doing overview duty. Now each
   * challenger is ONE grid card carrying both halves, and a line renders only for an
   * execution with no proposal.
   */
  it("groups challenger cards by role (collapsible), groups newest-first, cards newest-first inside", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    const now = Date.now();
    const mkProp = (id: string, variantId: string, createdAt: number, role = "worker") => ({
      id,
      variantId,
      role,
      status: "rejected",
      cycle: 1,
      createdAt,
      harnessSlug: "papercusp",
    });
    gymResult = {
      data: [
        {
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          proposals: [
            mkProp("p-old", "cand-old", now - 9 * 3600_000),
            mkProp("p-new", "cand-new", now - 1 * 3600_000),
            mkProp("p-mid", "cand-mid", now - 5 * 3600_000, "director"),
          ],
          runs: [
            {
              harnessSlug: "papercusp",
              variantId: "cand-new",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 2 * 3600_000,
              finishedAt: now - 1 * 3600_000,
              decision: null,
              isBaseline: false,
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

    // Grouped by role — the per-type stacks the CardStack decks used to give.
    const groups = document.querySelectorAll(".pc-learning__gymrolegroup");
    expect(groups).toHaveLength(2); // worker + director
    const groupLabels = [...groups].map((g) => g.getAttribute("aria-label") ?? "");
    // Groups ordered by the recency of their newest challenger: worker (1h) before
    // director (5h) — NOT by group size.
    expect(groupLabels[0]).toContain("worker");
    expect(groupLabels[1]).toContain("director");
    // Each group header carries its count + newest age, so a collapsed group still
    // tells you whether it is active.
    const head = groups[0]!.querySelector(".pc-learning__gymrolehead");
    expect(head?.textContent).toContain("worker");
    expect(head?.textContent).toContain("2"); // two worker challengers
    expect(head?.getAttribute("aria-expanded")).toBe("true"); // expanded by default

    const cards = document.querySelectorAll(".pc-learning__gymcard");
    expect(cards).toHaveLength(3); // every challenger visible at once (no 1-of-N)
    // Newest-first WITHIN the worker group: p-new (1h) before p-old (9h).
    const workerCards = groups[0]!.querySelectorAll(".pc-learning__gymcard");
    expect(workerCards[0]!.getAttribute("aria-label")).toContain("cand-new");
    expect(workerCards[1]!.getAttribute("aria-label")).toContain("cand-old");
    // The matching run group's execution facts are folded into the card…
    expect(workerCards[0]!.textContent).toContain("3 runs");
    expect(workerCards[0]!.textContent).toContain("escalated");
    // …and that run no longer ALSO renders a duplicate compact line.
    expect(document.querySelector(".pc-learning__gymcycles")).toBeNull();
  });

  it("keeps a compact line ONLY for an execution with no proposal (the baseline)", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    const now = Date.now();
    gymResult = {
      data: [
        {
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          proposals: [
            {
              id: "p1",
              variantId: "cand-carded",
              role: "worker",
              status: "accepted",
              cycle: 1,
              createdAt: now - 3600_000,
              harnessSlug: "papercusp",
            },
          ],
          runs: [
            {
              harnessSlug: "papercusp",
              variantId: "cand-carded",
              cycle: 1,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 2 * 3600_000,
              finishedAt: now - 3600_000,
              decision: "accept",
              isBaseline: false,
            },
            {
              harnessSlug: "papercusp",
              variantId: "baseline",
              cycle: 0,
              runCount: 3,
              states: ["escalated"],
              startedAt: now - 4 * 3600_000,
              finishedAt: now - 3 * 3600_000,
              decision: null,
              isBaseline: true,
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

    expect(document.querySelectorAll(".pc-learning__gymcard")).toHaveLength(1);
    const lines = document.querySelector(".pc-learning__gymcycles");
    expect(lines).toBeTruthy(); // the baseline has no card, so it keeps its line
    expect(lines!.children).toHaveLength(1);
    expect(lines!.textContent).toContain("baseline");
    expect(lines!.textContent).not.toContain("cand-carded"); // no duplicate
  });

  it("omits the recency chip when there are no runs (no bogus 'newest')", () => {
    nuqsState.lview = "gym";
    advScopeState.slug = "papercusp";
    advScopeState.hive = "papercusp";
    gymResult = {
      data: [
        {
          proposals: [{ id: "p1", status: "pending", role: "worker" }],
          autoloops: [],
          archiveSeeds: [],
          cycles: [],
          runs: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<LearningTab />);
    expect(document.querySelector(".pc-learning__runsrecency")).toBeNull();
  });
});
