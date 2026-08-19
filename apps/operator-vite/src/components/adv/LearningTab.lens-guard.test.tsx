// @vitest-environment jsdom
//
// THE LENS-DISAGREEMENT GUARD (learning-tab-surface-public-release P-007, WI-6391)
// ═══════════════════════════════════════════════════════════════════════════════
//
// One invariant, standing over every Learning view, closing a bug class that has
// now been found FIVE times on this one surface:
//
//   EI-18799358267821549 — the improve funnel scoped its FIRST stage and not its
//                          later ones, so under a pot lens the funnel GREW
//                          (156 ideas → 605 approved: an impossible shape).
//   WI-6384             — Retain: `learning.hive` is gated `hive.length > 0` while
//                          its sibling `learning.retain` is not, so "All Pots" — the
//                          BROADEST lens — renders an empty main list beside a
//                          workspace-wide count strip.
//   WI-6385             — Improvements: `learning.scoutDrafts` takes no pot arg and
//                          no readiness gate while both sibling legs are scoped.
//
// Every instance is the same shape: ONE LEG OF A MULTI-READ VIEW DISAGREES WITH ITS
// SIBLINGS ABOUT THE LENS. The user cannot tell which numbers on screen respect the
// pot they selected, because the disagreement is invisible in the rendered output —
// two populations look exactly like one population.
//
// ─── Why this is a RENDER probe and not a source scan ───────────────────────────
//
// A grep/AST scan over the source can only see what the code SAYS. The funnel bug
// (EI-18799358267821549) proved a text-level assertion cannot catch this class: the
// predicate was present in the source and silently no-opped at runtime. This probe
// records what each component ACTUALLY ASKS FOR — the real `args` and `enabled` a
// mounted view passes to useSyncQuery — so it observes behaviour, not spelling.
//
// ─── Why it runs across THREE scope scenarios (read this before editing) ────────
//
// The defects are INVISIBLE under the obvious test setup, and that is the whole
// difficulty. With a pot selected and the scope resolved (`ready: true`):
//
//   · every sibling computes `enabled: hiveReady` === true, and
//   · a leg with NO `enabled` at all is also, semantically, enabled === true.
//
// A guard written only against that state compares true to true, reports PASS, and
// is structurally incapable of seeing either defect. So each scenario below is
// chosen because it makes a specific disagreement OBSERVABLE:
//
//   POT_READY    pot selected, scope resolved → every read must carry the pot arg.
//                Discriminates WI-6385's primary defect (args {} vs { hive }).
//   POT_PENDING  pot selected, scope NOT yet resolved → gated siblings go false
//                while an ungated leg stays true. Discriminates WI-6385's gate.
//   ALL_POTS     "All Pots" (hive ''), scope resolved → a leg gated on
//                `hive.length > 0` goes false while its siblings stay true.
//                Discriminates WI-6384.
//
// The `probeCanSee` suite at the bottom exists for the same reason and MUST NOT be
// deleted: a green result from a blind instrument is indistinguishable from a green
// result from a working one, so the probe proves it can see before it certifies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// ─── Minimal harness (mirrors LearningTab.test.tsx's pinned-sibling pattern) ────

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const nuqsState: Record<string, unknown> = {
  lview: "improvements",
  lane: "all",
  tab: null,
  grade: null,
  irail: null,
  itrace: null,
  rrubric: null,
  lretain: null,
  slug: null,
  lsb: null,
  lst: null,
  // Retained-ledger URL state (WI-39493/WI-39900). The real nuqs parsers carry
  // withDefault("all"); this mock drops parsers, so the bag must model the
  // default itself or the ledger renders with `rtab`/`rship` undefined — which
  // crashes the filter-honesty note's label lookup.
  rtab: "all",
  rship: "all",
};
import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [
    nuqsState[key],
    vi.fn((v: unknown) => {
      nuqsState[key] = v;
    }),
  ],
  useQueryStates: (keys: Record<string, unknown>) => [
    Object.fromEntries(Object.keys(keys).map((k) => [k, nuqsState[k] ?? null])),
    vi.fn((patch: Record<string, unknown>) => {
      Object.assign(nuqsState, patch);
    }),
  ],
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsString: { withDefault: () => ({}) },
  parseAsBoolean: { withDefault: () => ({}) },
}));

// The pot lens is INHERITED from the top-bar selector (owner directive 2026-07-26).
// Each scenario drives the lens by mutating this bag before render.
const advScopeState = {
  allMode: false,
  slug: "alpha-hive" as string | null,
  hive: "alpha-hive",
  ready: true,
};
vi.mock("./AdvShell", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./AdvShell")>();
  return { ...orig, useAdvScope: () => ({ ...advScopeState }) };
});

vi.mock("@/app/_components/RubricsPanel", () => ({
  default: () => <div data-testid="rubrics-panel" />,
}));
vi.mock("@/app/_components/RubricDetailPanel", () => ({
  default: () => <div data-testid="rubric-detail" />,
}));
vi.mock("@/app/adv/create/ObservationsPanel", () => ({
  default: () => <div data-testid="observations-panel" />,
}));
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
  Select: ({ ariaLabel }: { ariaLabel?: string }) => <select aria-label={ariaLabel} />,
}));
vi.mock("@/lib/useLexicon", () => ({ useLexicon: () => (k: string) => k }));

import { setFlagPayload } from "@papercusp/flags/client";
import { FLAGS, FLAG_DEFAULTS } from "@papercusp/flags";

/** The Gym view is gated behind FLAGS.TESTING (WI-6315) — without it the tab
 *  degrades `?lview=gym` to the default view, and a guard that did not arm the
 *  flag would silently audit the WRONG component while reporting on "gym".
 *
 *  (`wake-efficiency` used to need the same treatment behind
 *  MUG_KETTLE_SYSTEM. That view is now DELETED outright — P-059 / D-076 — so
 *  there is no second gate to pin: it is simply not in LVIEWS.) */
const setTestingFlag = (on: boolean) =>
  setFlagPayload({
    flags: { ...FLAG_DEFAULTS, [FLAGS.TESTING]: on },
    evaluatedAt: Date.now(),
    source: "override",
  });

// ─── The recorder: every useSyncQuery call a mounted view makes ────────────────

type Read = {
  queryName: string;
  args: Record<string, unknown> | undefined;
  /** As PASSED. `undefined` means the call site supplied no gate at all — which is
   *  exactly the WI-6385 defect, so it must stay distinguishable from `true`. */
  enabled: boolean | undefined;
};
let reads: Read[] = [];

vi.mock("@papercusp/sync", async () => ({
  // WI-6948: see LearningTab.test.tsx — the real AdvShell reaches lazyWithRetry, which
  // this package re-exports, so the factory must supply it.
  lazyWithRetry: (await import("react")).lazy,
  useSyncQuery: (opts: {
    queryName: string;
    args?: unknown;
    enabled?: boolean;
  }) => {
    reads.push({
      queryName: opts.queryName,
      args: (opts.args ?? undefined) as Record<string, unknown> | undefined,
      enabled: opts.enabled,
    });
    return {
      data: [],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
  },
  notifySyncInvalidate: vi.fn(),
  useSyncMutate: () => ({ mutate: vi.fn(), pending: false }),
}));

import LearningTab from "./LearningTab";

// ─── What the tab declares about itself ────────────────────────────────────────
//
// Mirrors LearningTab.tsx's own HIVE_AWARE_VIEWS. Kept as a literal (not imported)
// on purpose: if someone adds a view to the tab's set, the coverage test below
// fails until they consider the lens contract here too. That is the point — the
// tab's set and this guard's set are meant to be reconciled by a human, once.
const HIVE_AWARE_VIEWS = [
  "improvements",
  "gym",
  "learnings",
  "frontier",
  "throughput",
] as const;

/**
 * Reads inside a HIVE-AWARE view that are deliberately workspace-global.
 *
 * ⚠ THIS IS THE ONLY ESCAPE HATCH, AND IT REQUIRES A REASON. A read listed here is
 * asserting: "the number this produces is workspace-wide, and that is correct even
 * when the user has selected one pot." That is a real claim about what the user
 * sees — do not add an entry to make a red test go green. The right fix for a leg
 * that CAN be scoped is to scope it (see WI-6385: the pot column was there all
 * along, in the very table the funnel bug was about).
 */
const WORKSPACE_GLOBAL_READS: Record<string, string> = {
  // Retain view. VERIFIED AGAINST THE SCHEMA, not against the code comment:
  // `harness_shared.knowledge_pack_candidates` has no workspace_id, no
  // harness_slug and no pot column of any kind, and is read through getOrgPg()
  // — it is org-global by construction. A pack candidate is staged BECAUSE a
  // lesson recurred across hives, so "this pot's cross-hive candidates" is not
  // a meaningful set. Contrast WI-6385, where the pot column was present in the
  // table all along and the leg simply never used it.
  "knowledgePacks.candidates":
    "cross-hive recurrence escalations — table has no pot column (org-global store)",
};

/**
 * Reads issued by the TAB CHROME rather than by any view — the header's
 * infra-health chip and the Verify stage's readiness strip render OUTSIDE
 * `LearningViewContent` (LearningTab.tsx:737 and :747), so they appear in every
 * view's recording without belonging to any view. They are workspace-wide by
 * construction: the chip reports whether the learning PIPELINE is healthy, which
 * is not a per-pot fact.
 *
 * This is a separate list from WORKSPACE_GLOBAL_READS on purpose. "Chrome that
 * renders beside every view" and "a view leg that opted out of the lens" are
 * different claims, and collapsing them would let a real view read hide here.
 */
const TAB_CHROME_READS: Record<string, string> = {
  "learning.health": "header infra-health chip — pipeline health, not per-pot",
  "learning.releaseReadiness": "Verify-stage GO/NO-GO strip — workspace governance state",
  "learning.loopControl":
    "header pause/resume chip + loop spend (WI-39501) — renders in the stage row " +
    "beside every view; the self-improvement routine GROUP and its spend rollup are " +
    "workspace-wide facts, not per-pot",
};

const scenarios = {
  /** Pot selected, scope resolved. Discriminates a missing pot ARG. */
  POT_READY: { allMode: false, slug: "alpha-hive", hive: "alpha-hive", ready: true },
  /** Pot selected, scope NOT resolved. Discriminates a missing readiness GATE:
   *  gated siblings go false, an ungated leg stays true. */
  POT_PENDING: { allMode: false, slug: "alpha-hive", hive: "alpha-hive", ready: false },
  /** "All Pots" — the broadest lens, represented as hive ''. Discriminates a leg
   *  gated on a NON-EMPTY hive while its siblings are not. */
  ALL_POTS: { allMode: true, slug: null, hive: "", ready: true },
} as const;

/** Every read the tab issued while `view` was the mounted view, MINUS the tab
 *  chrome that renders regardless of view. */
function readsFor(view: string, scenario: keyof typeof scenarios): Read[] {
  Object.assign(advScopeState, scenarios[scenario]);
  nuqsState.lview = view;
  setTestingFlag(view === "gym");
  reads = [];
  render(<LearningTab />);
  // De-dupe by call site identity (queryName): React may render twice under
  // StrictMode-ish conditions, and a repeated identical read is not a finding.
  const byName = new Map<string, Read>();
  for (const r of reads) if (!byName.has(r.queryName)) byName.set(r.queryName, r);
  return [...byName.values()].filter((r) => !(r.queryName in TAB_CHROME_READS));
}

/** A view's reads, minus the ones a human explicitly registered as workspace-wide. */
const scoped = (rs: Read[]) => rs.filter((r) => !(r.queryName in WORKSPACE_GLOBAL_READS));

beforeEach(() => {
  reads = [];
  Object.assign(advScopeState, scenarios.POT_READY);
});
afterEach(() => {
  cleanup();
});

describe("Learning views agree with themselves about the pot lens", () => {
  describe.each(HIVE_AWARE_VIEWS)("%s", (view) => {
    it("every read carries the selected pot", () => {
      const rs = scoped(readsFor(view, "POT_READY"));
      expect(rs.length).toBeGreaterThan(0); // non-blind: see probeCanSee below

      const unscoped = rs.filter((r) => r.args?.hive !== "alpha-hive");
      expect(
        unscoped.map((r) => `${r.queryName} args=${JSON.stringify(r.args ?? {})}`),
      ).toEqual([]);
    });

    // The two gate scenarios are where the disagreements actually become visible.
    it.each(["POT_PENDING", "ALL_POTS"] as const)(
      "all reads share one readiness gate (%s)",
      (scenario) => {
        const rs = scoped(readsFor(view, scenario));
        expect(rs.length).toBeGreaterThan(0);

        // `undefined` (no gate supplied) is deliberately NOT collapsed into `true`:
        // an absent gate is the defect, and collapsing it is how a guard goes blind.
        const gates = [...new Set(rs.map((r) => String(r.enabled)))];
        expect(
          gates.length === 1
            ? []
            : rs.map((r) => `${r.queryName} enabled=${String(r.enabled)}`),
        ).toEqual([]);
      },
    );
  });
});

describe("workspace-global views do not silently take a pot lens", () => {
  // The converse drift: a view the tab does NOT consider pot-scoped must not
  // quietly scope one of its reads, or the tab strip lies about what the lens does.
  const WORKSPACE_VIEWS = [
    "signals",
    "pipeline",
    "benchmark",
    "orchestration",
    "bakeoff",
    "ekg",
    "red-queen",
    "experiments",
  ] as const;

  it.each(WORKSPACE_VIEWS)("%s passes no hive arg", (view) => {
    const rs = readsFor(view, "POT_READY");
    // NON-BLIND FIRST. "No read passed a hive arg" is trivially true of a view
    // that issued no reads at all — which is exactly what happened while this
    // file's mocks were incomplete and the views were THROWING on mount: nine
    // green checkmarks over nine components that never rendered. Assert the
    // view actually read something before certifying what it read.
    expect(rs.length).toBeGreaterThan(0);

    const scopedReads = rs.filter((r) => r.args?.hive != null);
    expect(scopedReads.map((r) => r.queryName)).toEqual([]);
  });
});

describe("probeCanSee — the instrument proves it is not blind", () => {
  // A green result from a blind instrument is indistinguishable from a green result
  // from a working one. Before any assertion above is trusted, the probe shows that
  // it observes the real call sites, the real args, and the real gates.

  it("records the reads a known view actually makes", () => {
    const rs = readsFor("improvements", "POT_READY");
    // The Improve view is the merged Ideas+Backlog surface: its identity is that it
    // reads BOTH provenance legs. If the recorder ever sees fewer than two reads
    // here, it is not wired to the component and every PASS above is vacuous.
    expect(rs.length).toBeGreaterThanOrEqual(2);
    expect(rs.map((r) => r.queryName)).toContain("learning.improvements");
  });

  it("observes the pot arg a scoped read passes", () => {
    const rs = readsFor("gym", "POT_READY");
    const gym = rs.find((r) => r.queryName === "learning.gym");
    expect(gym?.args).toEqual({ hive: "alpha-hive" });
  });

  it("observes a gate going false — the signal the gate assertions rely on", () => {
    // If `enabled` were not actually captured, every gate above would compare
    // undefined to undefined and pass unconditionally.
    const rs = readsFor("gym", "POT_PENDING");
    const gym = rs.find((r) => r.queryName === "learning.gym");
    expect(gym?.enabled).toBe(false);
  });

  it("distinguishes an ABSENT gate from an explicit true", () => {
    // The distinction the whole gate assertion rests on. A recorder that
    // normalized `undefined` → `true` would silently permit WI-6385 forever.
    const sample: Read[] = [
      { queryName: "a", args: {}, enabled: true },
      { queryName: "b", args: {}, enabled: undefined },
    ];
    expect([...new Set(sample.map((r) => String(r.enabled)))]).toHaveLength(2);
  });

  it("covers every view the tab declares pot-aware", () => {
    // Guards against the quiet failure where someone adds a hive-aware view to
    // LearningTab and this file never learns about it.
    expect([...HIVE_AWARE_VIEWS].sort()).toEqual(
      ["frontier", "gym", "improvements", "learnings", "throughput"].sort(),
    );
  });
});
