/**
 * The workspace learning loop: Observe → Improve → Verify → Retain.
 * Each stage composes the existing sync-backed panels; `?lview=` remains the
 * canonical deep-link state and `?lhive=` scopes the hive-aware views.
 */
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  useQueryState,
  useQueryStates,
  parseAsStringEnum,
  parseAsString,
  parseAsBoolean,
} from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
  UserRound,
  CheckCircle2,
  Dumbbell,
  Sparkles,
  XCircle,
  Clock,
  HelpCircle,
  Gauge,
  BookOpen,
  ArrowUp,
  ArrowDown,
  Minus,
  Activity,
  Repeat2,
  Hourglass,
  Radar,
  Brain,
  Star,
  MessageSquarePlus,
  Send,
  Eye,
  Lightbulb,
  FlaskConical,
  GitBranch,
  Beaker,
  Search,
  Telescope,
  Rss,
  Microscope,
  Workflow,
  Zap,
} from "lucide-react";
// WI-7279: the wire shape is NARROWER than the server-side ScoredItem — the
// resolver projects humanQueue to the fields this tab actually reads. Import the
// wire type, not ScoredItem, so reading a field that is no longer sent fails to
// compile here instead of silently evaluating to `undefined` at runtime.
import type {
  LearningImprovementsRow,
  SlimHumanQueueItem,
} from "@papercusp/operator-core/lib/harness/improvements/learning-digest-snapshot";
import { CATEGORICAL, SEVERITY } from "@/app/harness/theme";
import type { ImprovementFlow } from "@papercusp/operator-core/lib/harness/improvements/flow-metrics";
import type {
  ScoutSnapshot,
  ScoutRoutedItem,
  ScoutTickEconomics,
  ScoutCadenceState,
  ScoutDraftIteration,
} from "@papercusp/operator-core/lib/sync-resolver/learning-scout-read";
import type { HiveLearningsSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-hive-read";
import type { RetainExtrasSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-retain-read";
import type { HiveThroughputSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-hive-throughput-read";
import type { PotSoakReportSnapshot } from "@papercusp/operator-core/lib/pot/soak-report";
import type { ReleaseReadinessSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-release-readiness-read";
import { tabOverflowState, useAdvScope } from "./AdvShell";
import { BenchmarkTrend, type BenchmarkTrendInstance } from "./BenchmarkTrend";
import type { BakeoffTrendRow } from "@papercusp/operator-core/lib/pot-eval/bakeoff-trend";
import { EkgPanel } from "./EkgPanel";
import { RedQueenPanel } from "./RedQueenPanel";
import { FrontierPanel } from "./FrontierPanel";
import { SignalsPanel } from "./SignalsPanel";
import { AnalyzePanel } from "./AnalyzePanel";
import KnowledgePackCandidates from "./KnowledgePackCandidates";
import { ExperimentsPanel } from "./ExperimentsPanel";
import { Tooltip } from "@/app/harness/Tooltip";
import { Popover } from "@/app/harness/Popover";
import { CardStack } from "@papercusp/card-stack";
import { useColumnFilters, ColumnFilterBar } from "@/app/harness/filters";
import type { FilterableColumn } from "@papercusp/grid-core";
import { statusToneColor } from "@/app/harness/theme";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import { usePromptDialog } from "@/app/harness/usePromptDialog";
import { hiveHomeLabel } from "@/lib/hive-label";
import { useLexicon } from "@/lib/useLexicon";
import { useFlag } from "@papercusp/flags/client";
import { FLAGS } from "@papercusp/flags";
import LearningInfraHealthChip from "./LearningInfraHealthChip";
import LearningEfficacyPanel from "./LearningEfficacyPanel";
import RubricsPanel from "@/app/_components/RubricsPanel";
import RubricDetailPanel from "@/app/_components/RubricDetailPanel";
import ObservationsPanel from "@/app/adv/create/ObservationsPanel";
import {
  beginInteraction,
  PERF_INTERACTIONS,
} from "@/app/_components/perf/perf-marks";
import { useInteractionSettle } from "@/app/_components/perf/use-interaction-settle";
import {
  LearningComparisonBars,
  LearningDisclosure,
  LearningEvidenceRail,
  LearningHeroMetric,
  LearningPageHeader,
  LearningStatLine,
  LearningVisualEmpty,
  LearningVisualError,
  LearningVisualStyles,
} from "./LearningVisuals";
import { snapshotFault } from "./snapshot-fault";

const LVIEWS = [
  "signals",
  "observations",
  "rubrics",
  "pipeline",
  // `ideas` was RETIRED 2026-07-27 (learning-tab-surface-public-release P-003,
  // owner Option A: "okay lets go with a but keep the observe tab"). The Ideas
  // ledger and the Backlog were two lists over one population — the generator's
  // output and the work that output became — and reading either alone told half
  // the story. They are now ONE list under `improvements`; a stale `?lview=ideas`
  // deep-link is redirected there (see LearningTab's redirect effect).
  "gym",
  "improvements",
  "benchmark",
  "orchestration",
  "bakeoff",
  "ekg",
  "red-queen",
  "experiments",
  "frontier",
  "throughput",
  "learnings",
] as const;
type LView = (typeof LVIEWS)[number];

type LearningStage = "observe" | "analyze" | "improve" | "verify" | "retain";
type LearningViewStatus = "neutral" | "good" | "warn" | "bad";
type LearningStatusSemantic = "attention" | "failure";

function statusSemantic(
  status: LearningViewStatus,
): LearningStatusSemantic | null {
  if (status === "bad") return "failure";
  if (status === "warn") return "attention";
  return null;
}

function statusDescription(status: LearningViewStatus): string {
  const semantic = statusSemantic(status);
  if (semantic === "attention") return "needs attention";
  if (semantic === "failure") return "data unavailable";
  return "";
}

/** One-line "what is this view FOR" per tab (owner ask 2026-07-19: a tooltip
 *  that repeats the tab's name is not a tooltip). Rendered as the tab's
 *  title/tooltip; the label stays the aria name. Record<LView,…> so a new
 *  view cannot ship without one. */
/** Built per-render from the active lexicon (restore-pot-lexicon P-006 — same
 *  pattern as railMeta): the tenancy noun in these one-liners must track the
 *  FLAGS.THE_HIVE pack instead of hardcoding one pack's label. */
function viewDescriptions(t: ReturnType<typeof useLexicon>): Record<LView, string> {
  const pot = t("pot", { lower: true });
  return {
    signals:
      "What the learning pipeline is being fed, and what will make it fire next.",
    observations:
      "Pre-idea sensor readings agents file at turn end — browse-only; only recurring ones get promoted to work.",
    rubrics:
      "The quality rubrics live behavior is judged against, with their grade history.",
    pipeline:
      "Inside each idea-generation cycle: ideator roster, raw ideas, critique verdicts, fusions, and where they routed.",
    gym: `Prompt-optimization experiments — challengers vs champions — plus ${t("scout")}-seeded archive niches.`,
    improvements:
      "What the learning loop produced: each idea and the work it became, from not-ready-yet through shipped. Grading an idea here is what teaches the generator.",
    benchmark:
      "Whole-system benchmark runs (the IQ battery) — is a new instance measurably better?",
    orchestration: `${t("pot")}-eval scoring trends — is orchestration quality improving over time?`,
    bakeoff:
      "Comparative scoring across competing framework setups on the same tasks.",
    ekg: "The learning loop's vital signs over time, at a glance.",
    "red-queen":
      "Adversarial-pressure tracking — is quality keeping pace as the environment hardens?",
    experiments: "A/B experiments the loop has run, and how they came out.",
    frontier: "Mined improvement territory the loop has not explored yet.",
    // WI-6383: the old line ("how much each pot banks") described Retain, not
    // this view — nothing here counts what was banked. It renders the loop's
    // operating yardstick, so the tooltip now names what is actually on screen.
    throughput: `Whether each ${pot}'s loop is keeping up — placement rate, how busy its fleet is, and what is stuck.`,
    learnings: `The ${pot}'s shared memory — what it keeps and recalls while it works.`,
  };
}

/** One line per stage of the loop, same rule. */
const STAGE_DESCRIPTIONS: Record<LearningStage, string> = {
  observe: "What the system sees: raw signals, observations, rubric grades.",
  analyze: "What idea generation does with it, cycle by cycle.",
  improve: "What the loop produced: ideas, experiments, and the work backlog.",
  retain: "What the system keeps: shared memory and adopted lessons.",
  // Generic / whole-system, NOT per-run (owner ask 2026-07-19) — every view
  // here measures the system at large, so it reads as the outermost ring after
  // the loop banks its lesson. Per-run outcomes live in Improve → Ideas.
  verify:
    "Is the SYSTEM measurably better over time — benchmarks, scoring trends, the release gate (whole-system, not per-idea).",
};

/** The Verify stage's views — hoisted so the stage can be declared LAST in
 *  {@link STAGES} (owner ask 2026-07-19) without burying the list mid-array. */
const VERIFY_VIEWS: ReadonlyArray<{ id: LView; label: string; icon: typeof Eye }> = [
  { id: "benchmark", label: "Benchmark", icon: FlaskConical },
  // P-006: this view renders hive-eval SCORING trends (is orchestration
  // quality improving?), not an orchestration control surface — the label
  // says what the numbers are, not what they measure over.
  { id: "orchestration", label: "Pot scoring", icon: GitBranch },
  { id: "bakeoff", label: "Framework bake-off", icon: Repeat2 },
  { id: "ekg", label: "EKG", icon: Activity },
  { id: "red-queen", label: "Red Queen", icon: Radar },
  { id: "experiments", label: "Experiments", icon: Beaker },
  { id: "frontier", label: "Frontier", icon: Telescope },
  // WI-6383: RESTORED. Throughput shipped as a real subtab (2026-06-13), was
  // converted to a header "Loop health" utility icon (2026-07-11), and lost its
  // only entry point when that whole utility row was deleted the next day. The
  // view kept working the entire time — LVIEWS, the render dispatch and the
  // resolver all survived — so for 15 days it was reachable ONLY by hand-typing
  // `?lview=throughput`. It does not go back in the header: the header removal
  // was deliberate and is still pinned ("keeps operational destinations out of
  // the learning header"), so it returns as what it originally was, a subtab.
  //
  // WHY Verify. It is a whole-system operating measurement, not a per-idea one:
  // placement rate, fleet saturation, stuck count, mean-time-to-complete. That
  // is the same family as its neighbours Wake efficiency and EKG. It sits after
  // Frontier because those two are the stage's HIVE-AWARE pair (P-005), so the
  // pot lens applies to an adjacent run of tabs rather than a scattered one.
  { id: "throughput", label: "Throughput", icon: Zap },
];

const STAGES: ReadonlyArray<{
  id: LearningStage;
  label: string;
  icon: typeof Eye;
  views: ReadonlyArray<{ id: LView; label: string; icon: typeof Eye }>;
}> = [
  {
    id: "observe",
    label: "Observe",
    icon: Eye,
    views: [
      { id: "signals", label: "Signals", icon: Rss },
      { id: "observations", label: "Observations", icon: Eye },
      { id: "rubrics", label: "Rubrics", icon: Gauge },
    ],
  },
  // P-009 (owner ask 2026-07-18: "I want the user to be able to see the
  // advanced things happening as part of idea generation, I dont want to hide
  // it"): the pipeline-transparency stage between Observe and Improve —
  // per-cycle divergent generation, adversarial critique, and fusion.
  {
    id: "analyze",
    label: "Analyze",
    icon: Microscope,
    views: [{ id: "pipeline", label: "Pipeline", icon: Workflow }],
  },
  {
    id: "improve",
    label: "Improve",
    icon: Lightbulb,
    views: [
      { id: "gym", label: "Gym", icon: Dumbbell },
      // ONE list, not two (P-003, owner Option A 2026-07-27). It was "Backlog"
      // only to disambiguate it from a sibling "Ideas" tab that no longer
      // exists; the merged view carries BOTH halves of the loop's output — the
      // idea and the work it became — so it is named for the stage's verb. The
      // lview id stays `improvements`: deep-links depend on it.
      { id: "improvements", label: "Improvements", icon: Sparkles },
    ],
  },
  {
    id: "retain",
    label: "Retain",
    icon: Brain,
    views: [{ id: "learnings", label: "Learnings", icon: Brain }],
  },
  // Verify sits AFTER Retain (owner ask 2026-07-19: "is the verify actually
  // verifying the runs... if it's a generic verify putting it before retain is
  // weird"). It is generic: every view here reads a WHOLE-SYSTEM measurement
  // (learning.releaseReadiness, learning.hiveEvalTrend, learning.bakeoff,
  // learning.soakReport, wake efficiency) — none of them joins to the ideas or
  // improvements this loop just produced. Per-RUN outcome tracking already
  // lives in Improve (the Ideas funnel routed→filed→claimed→done and the
  // per-idea trace ending in grade→outcome). So this is the outermost feedback
  // ring — "did the system as a whole get better" — which follows banking the
  // lesson rather than gating it. See the same note on STAGE_DESCRIPTIONS.
  {
    id: "verify",
    label: "Verify",
    icon: Gauge,
    views: VERIFY_VIEWS,
  },
];

// Exported READ-ONLY, under a qualified name, for the reachability guard —
// which has to reconstruct the real pre-fix catalog to prove it reds on the
// actual defect rather than on a synthetic stand-in (WI-6383).
export { STAGES as LEARNING_STAGES };

// Same contract, for the perf-settle COVERAGE guard (WI-7263): that guard needs
// the true size of the view population to tell "a view was added without a
// settle point" apart from "the settle points moved". Deriving it from
// LEARNING_STAGES instead would be circular — the reachability guard already
// pins those two lists to each other, so a view added to BOTH would slip
// through unmeasured.
export { LVIEWS as LEARNING_VIEWS };

/**
 * Every `?lview=` value that NO navigation can reach — the detector for the
 * WI-6383 class.
 *
 * THE CLASS. `LVIEWS` (what `?lview=` accepts, what the render dispatch
 * switches on) and {@link STAGES} (what the stage/subtab nav offers) are two
 * parallel lists over the same population. Nothing made them agree, so a view
 * could be deleted from the nav while staying fully alive everywhere else — no
 * type error, no failing test, no dead code for `knip` to find. Throughput sat
 * in exactly that state for 15 days: implemented, routed, resolver live,
 * unreachable. Restoring the one tab does not stop the next one going the same
 * way; this does.
 *
 * `catalog`/`views` are injectable ONLY so the guard test can prove the
 * detector reds on the real pre-fix catalog rather than on a synthetic one —
 * production callers pass nothing. Deliberately checks the UNFILTERED catalog:
 * a flag-gated view (see {@link TESTING_ONLY_VIEWS}, folded in by
 * {@link hiddenViews}) is hidden on purpose and still reachable when its flag
 * is on, which is not this defect.
 */
export function orphanedLearningViews(
  catalog: typeof STAGES = STAGES,
  views: readonly LView[] = LVIEWS,
): LView[] {
  const reachable = new Set<string>(
    catalog.flatMap((stage) => stage.views.map((candidate) => candidate.id)),
  );
  return views.filter((view) => !reachable.has(view));
}

/** Views hidden from the Learning tab unless FLAGS.TESTING is on.
 *
 *  The Gym is NOT public-release ready [owner 2026-07-27: "Put all the gym
 *  features behind a testing flag, it isnt ready at all and I dont want to get
 *  that ready now."]. It rides FLAGS.TESTING — the SAME flag that
 *  already hides the `/dev/gym` route (design-simplification P-013) — so every
 *  gym surface sits behind ONE switch, and no new dark flag has to be minted
 *  (which would spend DARK_FLAGS_HIGH_WATERMARK budget to gate what an existing
 *  flag already gates).
 *
 *  WHY it is not ready, measured 2026-07-27 (WI-6315): the gym optimizes prompt
 *  overrides for `coding-solo`'s worker/validator roles — 8 and ZERO live tool
 *  invocations respectively — on a generated 4-line stub substrate whose only
 *  build gate is `node --check`, scored by an LLM composite rather than an
 *  observed outcome. The Improve→Gym arrow is decorative as well: 0.6% of
 *  triaged ideas route to it, and a routed idea only becomes hint text in the
 *  proposer prompt. A public user opening Improve would see a loop that visibly
 *  does not close.
 *
 *  {@link STAGES} stays the single catalog: this filters a COPY, so the
 *  flag-ON path is byte-identical to what shipped before the gate. */
const TESTING_ONLY_VIEWS: ReadonlySet<LView> = new Set<LView>(["gym"]);

/* The `wake-efficiency` view (MugWakeEfficiencyPanel) used to be hidden here
 * behind FLAGS.MUG_KETTLE_SYSTEM. It is now DELETED outright — the Mug/Kettle
 * tier is retired (D-074), so the pane could only ever render an empty
 * live-Mug read for a system that cannot run
 * (retire-mug-kettle-su-only-2026-08-09 P-059 / D-076). The panel itself is in
 * `_retired/mug-kettle-deciders/`.
 *
 * ⚠ `red-queen` and `frontier` were deliberately NEVER part of that set, though
 * a filename scan would sweep both in (D-020): RedQueenPanel is the
 * SELF-HEALING drill — "Red Queen" is the evolutionary arms-race term, not the
 * Mug — and FrontierPanel renders the learning-loop lane grid. Both belong to
 * the learning system D-001 keeps INTACT. Do not retire them with the tier. */

/** The one rule both the nav filter and the render degradation read.
 *
 *  Deriving them separately is how the two lists drift — the same defect
 *  {@link orphanedLearningViews} exists to catch between LVIEWS and STAGES, one
 *  level down. A view hidden from the nav but still rendered by a stale
 *  `?lview=` is not a smaller bug than the reverse. */
function hiddenViews(testingOn: boolean): ReadonlySet<LView> {
  const hidden = new Set<LView>();
  if (!testingOn) for (const v of TESTING_ONLY_VIEWS) hidden.add(v);
  return hidden;
}

function visibleStages(testingOn: boolean): typeof STAGES {
  const hidden = hiddenViews(testingOn);
  if (hidden.size === 0) return STAGES;
  return STAGES.map((stage) => ({
    ...stage,
    views: stage.views.filter((candidate) => !hidden.has(candidate.id)),
    // A stage whose every view is gated would render an empty pane rather than
    // disappear, so drop it — today none is (Improve keeps Ideas + Backlog).
  })).filter((stage) => stage.views.length > 0);
}

function stageForView(view: LView): LearningStage | null {
  return (
    STAGES.find((stage) =>
      stage.views.some((candidate) => candidate.id === view),
    )?.id ?? null
  );
}

function stageStatus(
  stage: (typeof STAGES)[number],
  statuses: Partial<Record<LView, LearningViewStatus>>,
): LearningViewStatus | null {
  const visible = stage.views
    .map((candidate) => statuses[candidate.id])
    .filter((status): status is LearningViewStatus => Boolean(status));
  if (visible.includes("bad")) return "bad";
  if (visible.includes("warn")) return "warn";
  if (visible.includes("good")) return "good";
  return visible.length > 0 ? "neutral" : null;
}

/** Sub-views whose data is scoped to ONE Hive (the tenancy unit, D-008) — they
 *  read the tab-level `?lhive=`. P-005 (pot-scope-all-learnings): Scout (ideas),
 *  Frontier and Throughput joined the lens — their stores carry a pot, or
 *  resolve one via registry membership. Still workspace-global: views whose
 *  tables have no pot column (Benchmark, Knowledge, EKG/RedQueen, Bakeoff,
 *  Experiments, Wake-efficiency, Signals, Observations, Rubrics, Analyze). */
const HIVE_AWARE_VIEWS: ReadonlySet<LView> = new Set<LView>([
  "improvements",
  "gym",
  "learnings",
  "frontier",
  "throughput",
]);

/** P-009: the one deep-link the teaching empty states and the orientation
 *  banner share — opens the left rail on the Blender pane, whose Arming section
 *  is the switchboard every "make data appear here" action points at. Writes
 *  the SAME nuqs keys LeftSidebar owns (`lsb`/`lst`; tab ids are frozen). */
/**
 * The LeftSidebar tab that actually contains the Arming (spend-gate) controls.
 *
 * ⚠ MUST be a member of LeftSidebar's `TAB_IDS` — `lst` is parsed with
 * `parseAsStringLiteral(TAB_IDS)`, so an id that is not in that list is SILENTLY
 * REJECTED and the sidebar falls back to its default tab. That is exactly how
 * this button rotted into a no-op: it wrote `lst: "blender"` back when a Blender
 * tab existed, the tab was later replaced, and the deep link kept "working"
 * (writing a URL param) while doing nothing visible (owner report 2026-07-27:
 * "what does the Open Arming button do, it doesnt seem to do anything").
 *
 * Arming today = `AutomationPane` with `lens="llm"` (its `showArming` gate),
 * which is rendered by `AgentsTab` under the `agents` tab — hence 'agents'.
 * `qAgents: 'routines'` picks that pane's lane explicitly instead of relying on
 * its default, so the link lands on Arming even if the lane default changes.
 * If you rename these, update this constant: the guard test asserts the pair.
 */
export const ARMING_SIDEBAR_TAB = "agents";
export const ARMING_AGENTS_LANE = "routines";

function useOpenArming(): () => void {
  const [, setRail] = useQueryStates({
    lsb: parseAsBoolean,
    lst: parseAsString,
    qAgents: parseAsString,
  });
  return useCallback(
    () =>
      void setRail({
        lsb: true,
        lst: ARMING_SIDEBAR_TAB,
        qAgents: ARMING_AGENTS_LANE,
      }),
    [setRail],
  );
}

/** P-009 first-run orientation banner — ONCE PER WORKSPACE (owner decision
 *  2026-07-26): dismissal persists in localStorage (UI state, not a feature
 *  flag; the desktop app is one workspace per install). */
const ORIENTATION_DISMISS_KEY = "pc-learning-orientation-dismissed";

function LearningOrientationBanner() {
  const t = useLexicon();
  const openArming = useOpenArming();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ORIENTATION_DISMISS_KEY) === "1";
    } catch {
      return true; // storage unavailable ⇒ fail quiet, never re-nag each render
    }
  });
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(ORIENTATION_DISMISS_KEY, "1");
    } catch {
      /* best effort */
    }
  };
  const pot = t("pot", { lower: true });
  return (
    <div
      className="pc-learning__orient"
      role="note"
      aria-label="How learning works"
    >
      <div className="pc-learning__orientbody">
        <strong>Your {pot} learns as you work</strong>
        <p>
          Agents capture friction the moment they hit it, the Gym A/B-refines
          your playbooks under a budget you set, and the {t("scout")} explores
          new ideas from this {pot}&apos;s own history — everything it learns is
          scoped to this {pot}.
        </p>
        <button
          type="button"
          className="pc-learning__orientaction"
          onClick={openArming}
        >
          Open Arming
        </button>
      </div>
      <button
        type="button"
        className="pc-learning__orientdismiss"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

export default function LearningTab() {
  const t = useLexicon();
  const viewDesc = viewDescriptions(t);
  const [lview, setLview] = useQueryState(
    "lview",
    parseAsStringEnum<LView>([...LVIEWS]).withDefault("improvements"),
  );
  const [rubricId, setRubricId] = useQueryState("rrubric", parseAsString);
  const [, setGradeDetail] = useQueryState("grade", parseAsString);
  const [, setRetainDetail] = useQueryState("lretain", parseAsString);
  // FLAGS.TESTING gates the Gym view (see TESTING_ONLY_VIEWS). Resolve it here
  // so a stale `?lview=gym` deep-link — a bookmark, an old link in a report, the
  // param left in the URL when the flag is turned off — lands on the default
  // view instead of rendering a pane the tab no longer offers.
  const testingOn = useFlag(FLAGS.TESTING);
  // A stale `?lview=wake-efficiency` (the deleted Mug/Kettle view, D-076) is no
  // longer a hidden-but-known id — it is simply not in LVIEWS, so the
  // membership test below rejects it into the default view.
  const stages = useMemo(() => visibleStages(testingOn), [testingOn]);
  const requestedView: LView = (LVIEWS as readonly string[]).includes(lview)
    ? (lview as LView)
    : "improvements";
  const view: LView = hiddenViews(testingOn).has(requestedView)
    ? "improvements"
    : requestedView;

  // P-003: keep the URL naming the view actually on screen. Two ways it can
  // lie, and BOTH resolve here rather than in a per-case special: a retired id
  // (`?lview=ideas` — the Ideas ledger merged into Improvements), and a valid
  // but flag-hidden id (`?lview=gym` with FLAGS.TESTING off). In each case the
  // pane already degrades to the default above, so this is not about what
  // renders — it is that the URL is the AGENT-VISIBLE control surface (repo
  // rule: user-meaningful state lives in nuqs, and ui:get_state reads it). A
  // param naming a view nobody is looking at is a real bug for the reader
  // driving this tab through ui:dispatch, not cosmetics.
  //
  // Read through the RAW param, not `lview`: parseAsStringEnum resolves an
  // unknown value to the default, so the enum hook can never SEE "ideas" — only
  // the raw string can. Writing null-safe (no param ⇒ no write) keeps a clean
  // URL clean instead of stamping ?lview=improvements on every mount.
  const [lviewRaw, setLviewRaw] = useQueryState("lview", parseAsString);
  useEffect(() => {
    if (lviewRaw != null && lviewRaw !== view) void setLviewRaw(view);
  }, [lviewRaw, setLviewRaw, view]);

  // Perf: begin the learning-view-switch interaction on a view CHANGE — the
  // "expanding the sections" gesture the owner reported as taking several
  // seconds (EI-19375505819043214). The matching endInteraction fires in the
  // selected panel when its primary read resolves.
  //
  // Keyed off `view` (the view actually rendered), not `lview`/`lviewRaw`: a
  // flag-hidden or retired id degrades to the default above, and timing a
  // switch to a pane nobody is looking at would measure the wrong render.
  //
  // The FIRST mount is deliberately skipped. Mount cost is a different
  // interaction with a different cause (it is harness-dock-open's territory),
  // and folding it in here would blend two populations under one budget — the
  // exact conflation that made command-palette-open report a 7.6x regression
  // that did not exist (WI-6543).
  //
  // ⚠ useLayoutEffect, NOT useEffect — this is a CORRECTNESS requirement, not a
  // style choice, and getting it wrong silently corrupts every measure this
  // instrument emits (EI-19375505819043214, measured 2026-08-02).
  //
  // React runs effects in phases, and within a phase CHILD BEFORE PARENT. The
  // settle points live in the child panels (AnalyzePanel, ObservationsPanel,
  // ImprovementsView) as passive `useEffect`s. So with a passive begin HERE,
  // the order on a view switch is:
  //
  //     child endInteraction  →  parent beginInteraction        (WRONG)
  //
  // A panel whose data is already cached settles ON MOUNT, so its
  // endInteraction runs FIRST and consumes whatever start mark is lying
  // around — the PREVIOUS view's dangling start (dangling because that view
  // has no settle point, or settled before its own begin). The emitted measure
  // then spans "time the user spent on the previous view", which is unbounded
  // and has nothing to do with render cost. Observed: a headless run that
  // dwelt 14s per view emitted a single 15,289ms measure — 14s of dwell plus
  // ~1.3s of actual settle — against a 1500ms budget. STALE_START_MS (30s)
  // does not save us: 15s is well inside it, so the garbage measure passes
  // through looking like a real 10x budget breach.
  //
  // ALL layout effects run before ANY passive effect, so a layout begin here
  // precedes every child settle regardless of the child-before-parent rule:
  //
  //     parent beginInteraction  →  child endInteraction        (correct)
  //
  // This holds only while the settle points stay PASSIVE. A panel that ever
  // settles in a layout effect re-opens the bug; the ordering contract is
  // pinned by LearningTab.perf-begin-order.test.tsx.
  const perfPrevViewRef = useRef<LView | null>(null);
  useLayoutEffect(() => {
    const prev = perfPrevViewRef.current;
    perfPrevViewRef.current = view;
    if (prev !== null && prev !== view) {
      beginInteraction(PERF_INTERACTIONS.learningViewSwitch);
    }
  }, [view]);

  // Pot lens INHERITED from the top-bar pot selector (owner directive
  // 2026-07-26: "the pot should be inherited by the currently selected pot" —
  // the tab-level `?lhive=` picker is GONE; one selection scopes every tab).
  // All Pots ⇒ '' ⇒ the workspace-wide rollup each hive-aware view already
  // supports. WI-5412 perf gate preserved: hive-aware views wait for the scope
  // to resolve (projects list loaded) so the first fetch runs with the real
  // lens, never a transient.
  const scope = useAdvScope();
  const hive = scope.hive;
  const hiveAware = HIVE_AWARE_VIEWS.has(view);
  const hiveReady = !hiveAware || scope.ready;
  const activeStage = stageForView(view);
  const activeStageMeta =
    stages.find((stage) => stage.id === activeStage) ?? null;
  const [viewStatuses, setViewStatuses] = useState<
    Partial<Record<LView, LearningViewStatus>>
  >({});
  const reportStatus = useCallback(
    (reportedView: LView, status: LearningViewStatus) => {
      setViewStatuses((current) =>
        current[reportedView] === status
          ? current
          : { ...current, [reportedView]: status },
      );
    },
    [],
  );
  const previousView = useRef<LView>(view);
  useEffect(() => {
    const previous = previousView.current;
    if (previous === view) return;
    if (previous === "improvements") void setGradeDetail(null);
    if (previous === "rubrics") void setRubricId(null);
    if (previous === "learnings") void setRetainDetail(null);
    previousView.current = view;
  }, [setGradeDetail, setRetainDetail, setRubricId, view]);

  // Work Queue parity without an unbounded hidden tree: keep the current pane
  // and the two most recent panes mounted. Normal back-and-forth stays warm,
  // while old chart trees and their live subscriptions are evicted.
  const [warmViews, setWarmViews] = useState<readonly LView[]>([view]);
  useEffect(() => {
    setWarmViews((current) =>
      [view, ...current.filter((candidate) => candidate !== view)].slice(0, 3),
    );
  }, [view]);
  // Include the newly selected view in this render; the effect persists it for
  // later renders without introducing a one-frame empty panel.
  const mountedViews = [
    view,
    ...warmViews.filter((candidate) => candidate !== view),
  ].slice(0, 3);

  // View-tab strip overflow affordance (P-007): when tabs are clipped, fade the
  // clipped edge so it reads "there are more views this way" instead of
  // silently cutting off. Same data-attr + mask pattern (and the same pure
  // tabOverflowState helper) as AdvShell's top-level tab strip.
  const viewListRef = useRef<HTMLDivElement | null>(null);
  const [viewOverflow, setViewOverflow] = useState({
    left: false,
    right: false,
  });
  const updateViewOverflow = useCallback(() => {
    const list = viewListRef.current;
    if (!list) {
      setViewOverflow({ left: false, right: false });
      return;
    }
    setViewOverflow(
      tabOverflowState(list.scrollLeft, list.scrollWidth, list.clientWidth),
    );
  }, []);
  useEffect(() => {
    const list = viewListRef.current;
    // activeStage in the deps: the strip's tab set (and whether the strip is
    // rendered at all) changes per stage, which changes scrollWidth without a
    // resize the ResizeObserver would see.
    updateViewOverflow();
    if (!list) return;
    list.addEventListener("scroll", updateViewOverflow, { passive: true });
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updateViewOverflow())
        : null;
    ro?.observe(list);
    return () => {
      list.removeEventListener("scroll", updateViewOverflow);
      ro?.disconnect();
    };
  }, [updateViewOverflow, activeStage]);
  // Only scroll the selected view tab into view when it is actually clipped
  // (e.g. a URL-restored view on a narrow pane) — never scroll away from
  // fully-visible tabs.
  useEffect(() => {
    const list = viewListRef.current;
    if (!list) return;
    const trigger = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!trigger) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = trigger.getBoundingClientRect();
    if (tabRect.left >= listRect.left && tabRect.right <= listRect.right)
      return;
    try {
      trigger.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      /* best effort */
    }
  }, [view]);

  return (
    <div className="pc-learning">
      <Tabs.Root
        className="pc-learning__stages"
        value={activeStage ?? ""}
        onValueChange={(next) => {
          // `stages`, not STAGES: clicking a stage lands on its FIRST VISIBLE
          // view, so a gated view can never be selected by the stage nav.
          const stage = stages.find((candidate) => candidate.id === next);
          if (stage?.views[0]) void setLview(stage.views[0].id);
        }}
      >
        <Tabs.List
          className="pc-learning__stage-list"
          aria-label="Learning loop stage"
        >
          {stages.map((stage, index) => {
            const Icon = stage.icon;
            const status = stageStatus(stage, viewStatuses);
            const semantic = status ? statusSemantic(status) : null;
            return (
              <Tabs.Trigger
                key={stage.id}
                value={stage.id}
                className="pc-learning__stage"
                aria-label={stage.label}
                title={STAGE_DESCRIPTIONS[stage.id]}
                aria-describedby={
                  status ? `learning-stage-status-${stage.id}` : undefined
                }
              >
                <span
                  className={`pc-learning__stage-icon${semantic ? ` has-${semantic}` : ""}`}
                >
                  <Icon size={16} aria-hidden />
                  {semantic ? (
                    <>
                      <span className="pc-learning__statusmark" aria-hidden />
                      <span
                        id={`learning-stage-status-${stage.id}`}
                        className="pc-learning__statusdesc"
                      >
                        {statusDescription(status!)}
                      </span>
                    </>
                  ) : null}
                </span>
                <span className="pc-learning__stage-label">{stage.label}</span>
                {index < stages.length - 1 ? (
                  <span className="pc-learning__stage-line" aria-hidden />
                ) : null}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
      </Tabs.Root>

      <div className="pc-learning__controls">
        {/* The per-tab pot picker that lived here is GONE (owner directive
            2026-07-26): the lens is inherited from the top-bar pot selector via
            useAdvScope — see the `hive` derivation above. The inherited pot is
            named in the strap line below so scope stays visible. */}
        {hiveAware && hive ? (
          <span className="pc-learning__hivepick" title={`Scoped to the ${t("pot", { lower: true })} selected in the top bar`}>
            <Brain size={12} aria-hidden />
            <span className="pc-learning__hivepicklabel">{hiveHomeLabel(hive)}</span>
          </span>
        ) : null}
        {activeStageMeta && activeStageMeta.views.length > 1 ? (
          <Tabs.Root
            className="pc-learning__view-tabs"
            data-stage={activeStageMeta.id}
            data-of-left={viewOverflow.left ? "" : undefined}
            data-of-right={viewOverflow.right ? "" : undefined}
            value={view}
            onValueChange={(next) => void setLview(next as LView)}
          >
            <Tabs.List
              ref={viewListRef}
              className="pc-learning__view-list"
              aria-label={`${activeStageMeta.label} views`}
            >
              {activeStageMeta.views.map((candidate) => {
                const Icon = candidate.icon;
                const status = viewStatuses[candidate.id];
                const semantic = status ? statusSemantic(status) : null;
                return (
                  <Tabs.Trigger
                    key={candidate.id}
                    value={candidate.id}
                    className={`pc-learning__view-tab${semantic ? ` has-${semantic}` : ""}`}
                    aria-label={candidate.label}
                    title={viewDesc[candidate.id]}
                    aria-describedby={
                      status
                        ? `learning-view-status-${candidate.id}`
                        : undefined
                    }
                  >
                    <span
                      className={`pc-learning__view-icon${semantic ? ` has-${semantic}` : ""}`}
                    >
                      <Icon size={12} aria-hidden />
                      {semantic ? (
                        <>
                          <span
                            className="pc-learning__statusmark"
                            aria-hidden
                          />
                          <span
                            id={`learning-view-status-${candidate.id}`}
                            className="pc-learning__statusdesc"
                          >
                            {statusDescription(status!)}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span className="pc-learning__view-label">
                      {candidate.label}
                    </span>
                  </Tabs.Trigger>
                );
              })}
            </Tabs.List>
          </Tabs.Root>
        ) : (
          <span />
        )}

        <LearningInfraHealthChip />
      </div>

      {/* P-009 lexicon gloss: the active view's one-liner, VISIBLE — a
          title-attr tooltip is undiscoverable for exactly the first-run user
          it serves. Same source as the tab tooltips (viewDescriptions). */}
      <p className="pc-learning__strap">{viewDesc[view]}</p>

      <LearningOrientationBanner />

      {stageForView(view) === "verify" ? <ReleaseReadinessStrip /> : null}

      <div className="pc-learning__body">
        {LVIEWS.filter((candidate) => mountedViews.includes(candidate)).map(
          (mountedView) => (
            <section
              key={mountedView}
              className="pc-learning__viewpane"
              data-view={mountedView}
              role="tabpanel"
              aria-label={stageForView(mountedView) ?? "Loop health"}
              hidden={mountedView !== view}
            >
              <LearningViewContent
                view={mountedView}
                active={mountedView === view}
                hive={hive}
                hiveReady={hiveReady}
                rubricId={rubricId}
                onRubricSelect={setRubricId}
                onStatus={reportStatus}
              />
            </section>
          ),
        )}
      </div>

      <LearningVisualStyles />
      <LearningStyles />
    </div>
  );
}

function LearningViewContent({
  view,
  active,
  hive,
  hiveReady,
  rubricId,
  onRubricSelect,
  onStatus,
}: {
  view: LView;
  /** True when THIS pane is the selected view. Panes are kept mounted while
   *  warm (see `warmViews`) and only `hidden` flips, so a pane can be mounted
   *  and inactive — which is why the perf settle points need this to fire on a
   *  revisit that does not remount (EI-19383745196363732). */
  active: boolean;
  hive: string;
  hiveReady: boolean;
  rubricId: string | null;
  onRubricSelect: (id: string | null) => void;
  onStatus: (view: LView, status: LearningViewStatus) => void;
}) {
  const reportViewStatus = useCallback(
    (status: LearningViewStatus) => onStatus(view, status),
    [onStatus, view],
  );
  if (view === "signals") {
    return <SignalsPanel onStatus={reportViewStatus} active={active} />;
  }
  if (view === "observations") {
    return <ObservationsPanel onStatus={reportViewStatus} active={active} />;
  }
  if (view === "pipeline") {
    return <AnalyzePanel onStatus={reportViewStatus} active={active} />;
  }
  if (view === "rubrics") {
    return (
      <div className="pc-learning__rubricsplit">
        <RubricsPanel
          onSelect={onRubricSelect}
          selectedId={rubricId}
          compact={Boolean(rubricId)}
          collapseUnscored
          onStatus={reportViewStatus}
          active={active}
        />
        {rubricId ? (
          <aside
            className="pc-learning__rubricdetail"
            aria-label="Rubric evidence"
          >
            <RubricDetailPanel
              rubricId={rubricId}
              onBack={() => onRubricSelect(null)}
            />
          </aside>
        ) : null}
      </div>
    );
  }
  if (view === "gym") {
    return (
      <GymView
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  }
  if (view === "improvements") {
    return (
      <ImprovementsView
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  }
  if (view === "benchmark") {
    return <ApiaryView onStatus={reportViewStatus} active={active} />;
  }
  if (view === "orchestration") {
    return <HiveEvalTrendView onStatus={reportViewStatus} active={active} />;
  }
  if (view === "bakeoff") {
    return <BakeoffTrendView onStatus={reportViewStatus} active={active} />;
  }
  if (view === "ekg")
    return <EkgPanel onStatus={reportViewStatus} active={active} />;
  if (view === "red-queen")
    return <RedQueenPanel onStatus={reportViewStatus} active={active} />;
  if (view === "experiments")
    return <ExperimentsPanel onStatus={reportViewStatus} active={active} />;
  if (view === "frontier")
    return (
      <FrontierPanel
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  if (view === "throughput") {
    return (
      <ThroughputView
        hive={hive}
        hiveReady={hiveReady}
        onStatus={reportViewStatus}
        active={active}
      />
    );
  }
  return (
    <LearningsView
      hive={hive}
      hiveReady={hiveReady}
      onStatus={reportViewStatus}
      active={active}
    />
  );
}

// ─── Release-readiness strip (learning-tab-alignment-2026-07-13 P-001) ───────
//
// The Verify stage's GO/NO-GO gate: blender:success-metrics' bars + the
// blender-release-readiness rubric's governance state. D-001: everything here
// renders the server read (learning.releaseReadiness), which reuses the SAME
// readers the MCP tools serve — no UI-side re-derivation.

function ReleaseReadinessStrip() {
  const sync = useSyncQuery<ReleaseReadinessSnapshot>({
    queryName: "learning.releaseReadiness",
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  if (!snap) return null; // loading / unreadable — the strip appears once the read lands
  const report = snap.report;
  const rubric = snap.rubric;
  const verdict = report?.verdict ?? null;

  return (
    <div
      className="pc-learning__readiness"
      role="status"
      aria-label="Release readiness"
    >
      <Tooltip
        label={
          report
            ? `The learning program's done-check over the live ledgers (window: ${report.window.ticks} ticks, ${report.window.routedIdeas} routed ideas). 'pass' only when every bar passes; 'incomplete' = a bar lacks evidence.`
            : (snap.errors?.join(" · ") ?? "success-metrics unreadable")
        }
      >
        <span
          className={`pc-learning__readiness-verdict pc-learning__readiness-verdict--${verdict ?? "unknown"}`}
        >
          <ShieldCheck size={12} aria-hidden />
          release gate: {verdict ?? "unreadable"}
          {report ? (
            <em>
              {report.passed}/{report.criteria.length}
            </em>
          ) : null}
        </span>
      </Tooltip>

      {(report?.criteria ?? []).map((c) => (
        <Tooltip key={c.key} label={`${c.bar} — ${c.observed}`}>
          <span
            className={`pc-learning__readiness-bar pc-learning__readiness-bar--${c.status}`}
          >
            {c.status === "pass" ? (
              <CheckCircle2 size={11} aria-hidden />
            ) : c.status === "fail" ? (
              <XCircle size={11} aria-hidden />
            ) : (
              <HelpCircle size={11} aria-hidden />
            )}
            {c.key}
          </span>
        </Tooltip>
      ))}

      <Tooltip
        label={
          rubric
            ? rubric.status === "active"
              ? `Ratified gate rubric (${rubric.criteriaCount} criteria)${rubric.ratifiedBy ? ` — ratified by ${rubric.ratifiedBy}` : ""}${rubric.proposedBy ? `, proposed by ${rubric.proposedBy}` : ""}.`
              : `The gate rubric is ${rubric.status} — not yet ratified (author ≠ ratifier governance). ${rubric.criteriaCount} criteria${rubric.proposedBy ? `, proposed by ${rubric.proposedBy}` : ""}.`
            : "No blender-release-readiness rubric proposed yet — the gate has no ratified spec."
        }
      >
        <span
          className={`pc-learning__readiness-rubric pc-learning__readiness-rubric--${rubric?.status ?? "missing"}`}
        >
          <Gauge size={11} aria-hidden />
          {rubric
            ? `rubric: ${rubric.status}${
                rubric.scorecardCount > 0
                  ? ` · ${rubric.scorecardCount} scorecard${rubric.scorecardCount === 1 ? "" : "s"}${rubric.latestScore10 != null ? ` · latest ${rubric.latestScore10}/10` : ""}`
                  : " · no scorecards yet"
              }`
            : "rubric: none proposed"}
        </span>
      </Tooltip>
    </div>
  );
}

// ─── Improve view (the merged loop-output list) ───────────────────────────────

const LANES = ["all", "auto", "human"] as const;
type Lane = (typeof LANES)[number];

/** Provenance scope — the mockup's scope bar (owner-approved 2026-07-27).
 *
 *  It filters by WHERE A ROW CAME FROM, and it is the single control that makes
 *  this view honest. Measured 2026-07-27: 8,202 rows — 99.93% of the old
 *  Backlog — were ALSO on the Work tab, because the backlog read applied no
 *  provenance filter at all. `loop` scopes to what the learning loop itself
 *  produced (~823); `all` is the deliberate escape hatch back to every capture.
 *
 *  `loop` is the resolver's DEFAULT (P-002) and the ONLY variant served from
 *  the precomputed snapshot — so the common path must pass NO scope arg. */
const LOOP_SCOPES = ["loop", "all"] as const;
type LoopScope = (typeof LOOP_SCOPES)[number];

function ageLabel(days: number): string {
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

/**
 * One row of the merged Improve list (P-003, owner Option A 2026-07-27).
 *
 * Improve used to be two tabs over ONE population: Ideas (the generator's
 * ledger) and Backlog (the work those ideas became). Reading either alone told
 * half the story — an idea with no visible fate, or a work item with no visible
 * origin. A row now carries both halves, and either may be absent:
 *
 * - `item` + `idea` — the common case: an idea that became work.
 * - `idea` only — [owner 2026-07-27 verbatim] "THE IMPROVE SHOULD JUST BE
 *   THE IDEAS BEFORE THEY GET INTO WORK ITEMS OR THE WORK ITEMS THAT CAME FROM
 *   IDEAS": an idea routed to a plan/gym/benchmark rail, or still held before
 *   it is filed. These are the "not ready yet" end of the pipeline.
 * - `item` only — a capture with no idea behind it. Under `loop` scope that is
 *   a PROVENANCE GAP worth seeing (see WI-6338: the three records of "Scout
 *   produced this" disagree by ~50%); under `all` scope it is simply a
 *   human/watchdog filing.
 */
interface LoopRow {
  key: string;
  item: SlimHumanQueueItem | null;
  idea: ScoutRoutedItem | null;
}

/** Is THIS row the deep-link target (`?lsel`)?
 *
 *  Both operands must be checked, not just compared: a row with no work item
 *  has `item?.id === undefined`, so a bare `row.item?.id === lsel` reports TRUE
 *  for every unfiled idea whenever `lsel` is itself nullish — which scroll-
 *  jacks the list and (in jsdom) throws on the un-implemented scrollIntoView.
 *  The pre-merge row compared an always-present string and could not hit this. */
function isSelectedRow(row: LoopRow, lsel: string | null): boolean {
  return lsel != null && row.item != null && row.item.id === lsel;
}

/**
 * The public pipeline vocabulary (P-004, owner ruling 2026-07-27).
 *
 * ONE set of words for where a thing is in the loop, used by the row chip AND
 * the funnel above the list so the summary and the rows cannot describe the
 * same population differently.
 *
 * These deliberately are NOT the storage vocabulary. `open` / `assignee` /
 * `resolved` describe the work-items table, not the question a reader is
 * asking; and the chip this replaces ("review" vs "auto", "Waits for your
 * review") described a HUMAN APPROVAL GATE that does not exist — in a full-auto
 * loop the human teaches the generator by grading and never approves the work.
 * Naming a gate that nobody operates invites someone to wait at it.
 */
type PipelineState = "not-ready" | "approved" | "in-flight" | "shipped" | "dropped";

const PIPELINE_STATES: Record<PipelineState, { label: string; desc: string }> = {
  "not-ready": {
    label: "not ready yet",
    desc: "The loop produced this idea but has not filed it as work yet.",
  },
  approved: {
    label: "approved",
    desc: "Filed as work. Waiting for an agent to pick it up.",
  },
  "in-flight": {
    label: "in flight",
    desc: "An agent is working on this right now.",
  },
  shipped: { label: "shipped", desc: "Landed." },
  dropped: { label: "dropped", desc: "Abandoned — closed without shipping." },
};

/**
 * Which pipeline state a merged row is in — exclusive by construction.
 *
 * ⚠ `ScoredItem.state` is the COLLAPSED three-value lifecycle
 * (`open|resolved|closed`) that `toLifecycleState` maps the unified work-item
 * enum onto — NOT the raw `done|dropped|wip|…` enum the server's SQL sees. The
 * two vocabularies read alike and mean different things, which is precisely how
 * EI-18792873324746237 put a permanent "0 shipped" on this tab. Do not copy a
 * state list between this function and a query.
 *
 * In practice only the first three are reachable here: the digest admits
 * ONLY open items into `autoEligible`/`humanQueue` ("Only OPEN items go into
 * the actionable queues" — digest.ts), so a terminal row cannot appear in this
 * list at all and `shipped` is a FUNNEL-only word today. The terminal branches
 * are kept anyway: they are one line each, and the alternative — falling
 * through to `approved` — would label a finished or abandoned item as waiting
 * work if that ever changes.
 */
function pipelineState(row: LoopRow): PipelineState {
  const item = row.item;
  if (!item) return "not-ready";
  if (item.state === "resolved") return "shipped";
  if (item.state === "closed") return "dropped";
  return item.assignee ? "in-flight" : "approved";
}

/** Recency for the merged sort, in days, from whichever half the row has.
 *  Work items carry `ageDays` from the digest; ideas carry a routing instant. */
function rowAgeDays(row: LoopRow, nowMs: number): number {
  if (row.item) return row.item.ageDays;
  const at = row.idea?.routedAt ? Date.parse(row.idea.routedAt) : NaN;
  return Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : (nowMs - at) / 86_400_000;
}

function ImprovementsView({
  hive,
  hiveReady,
  onStatus,
  active = true,
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const RAIL_META = railMeta(t);
  const openArming = useOpenArming();
  const [scope, setScope] = useQueryState(
    "lscope",
    parseAsStringEnum<LoopScope>([...LOOP_SCOPES]).withDefault("loop"),
  );
  // P-042: the tab-level hive lens scopes the feed to one hive's member-harness
  // improvements; '' ⇒ the workspace-wide feed (no hive arg). Gated on
  // hiveReady (WI-5412): this is the tab's heaviest read — firing it before
  // the lens resolves paid it twice on every first click.
  //
  // The scope arg is passed ONLY for 'all' (P-002): 'loop' is the resolver's
  // default, and the derived-read producer precomputes exactly the default
  // variant. Sending `scope:'loop'` explicitly would be a different args key,
  // miss the snapshot, and pay the 0.4-0.5s inline compute on every mount.
  const sync = useSyncQuery<LearningImprovementsRow>({
    queryName: "learning.improvements",
    args: {
      ...(hive ? { hive } : {}),
      ...(scope === "all" ? { scope: "all" } : {}),
    },
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const digest = sync.data?.[0];
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch — LearningTab
  // begins the interaction on the view change (EI-19375505819043214).
  //
  // WHY THIS VIEW MATTERS MOST: `improvements` is both the tab's DEFAULT
  // landing view and its heaviest read (learning.improvements measured
  // 320,607B on the live operator, ~98.6% of it a 454-row humanQueue). It is
  // therefore the view the owner most plausibly meant by "expanding the
  // sections took several seconds" — and until now it had no settle point at
  // all, so the instrument added to answer that report was structurally
  // incapable of measuring it. A per-view experiment run against the real
  // desktop reported nothing for this view for exactly this reason.
  //
  // Gated on the PRIMARY read only (learning.improvements), deliberately not
  // on the scout / drafts legs: those are secondary sections, and waiting on
  // them would attribute their cost to this interaction. Same rule as the
  // sibling settle points in AnalyzePanel and ObservationsPanel.
  //
  // Settles on a FAULT too, not just success — a slow FAILING view is exactly
  // what the owner described, and ending only on success would leave the start
  // mark dangling until STALE_START_MS discarded it, measuring nothing.
  //
  // Note `enabled: hiveReady` above: while the pot lens is unresolved the read
  // is disabled (loading false, data undefined, no error), so `settled` stays
  // false and the interaction correctly spans the lens resolution the user is
  // actually waiting through.
  //
  // Gated on `active` as well: this pane is kept MOUNTED when the user switches
  // away (warmViews below), so on a revisit `improvementsSettled` is already
  // true and never changes — an effect keyed on it alone would never re-run and
  // the switch would measure nothing (EI-19383745196363732).
  const improvementsSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    improvementsSettled,
    active,
  );
  // The idea half of the same population (absorbed from the retired Ideas
  // view): lens, rail, grounding trace, grade and outcome, plus the cycle
  // engine's own instruments. Same hive lens, same readiness gate.
  const scoutSync = useSyncQuery<ScoutSnapshot>({
    queryName: "learning.scout",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const snap = scoutSync.data?.[0];
  const routed = useMemo(() => snap?.recent ?? [], [snap]);
  const rails = snap?.railCounts ?? [];
  const health = snap?.health ?? { status: "neutral" as const, markers: [] };
  const groundingTitles = snap?.groundingTitles ?? {};
  // Drafts-in-iteration (moved here from the Ideas view — owner ask
  // 2026-07-19): a draft plan awaiting revision is WORK IN PROGRESS, so it
  // belongs on the backlog surface. Thin dedicated read, never the heavy
  // learning.scout snapshot.
  // WI-6385: same lens and same readiness gate as the two legs above. It
  // previously had neither, so under a selected pot this list showed every
  // pot's drafts beside two pot-scoped siblings.
  // WI-6395: enveloped (`[{ items, unavailable? }]`) so a failed read stops
  // arriving as "no drafts in iteration". This is a SECONDARY read on the
  // Improvements view — its failure must not blank the primary list, so it
  // degrades to an empty drafts section rather than an error page; the
  // provenance is still carried for the section's own copy.
  const draftsSync = useSyncQuery<{ items?: ScoutDraftIteration[] }>({
    queryName: "learning.scoutDrafts",
    args: hive ? { hive } : {},
    staleTime: 60_000,
    enabled: hiveReady,
  });
  const drafts = draftsSync.data?.[0]?.items ?? [];
  // WI-6410: the comment above promised "the provenance is still carried for
  // the section's own copy" — and nothing read it. The envelope was built, the
  // flag arrived, and this view dropped it on the floor, so a failed drafts read
  // rendered as no drafts section at all. A comment is not an enforcement
  // mechanism (the same lesson the server guard's header records); the guard
  // that now covers this file is.
  const draftsFault = snapshotFault(
    draftsSync.error,
    draftsSync.data?.[0],
    "Drafts in iteration",
  );
  const [lane, setLane] = useQueryState(
    "lane",
    parseAsStringEnum<Lane>([...LANES]).withDefault("all"),
  );
  // Source facet (`?lsrc=`): who filed it — Scout / Queen / system / … (payload.sourceRole).
  const [src, setSrc] = useQueryState("lsrc", parseAsString);
  // Selected item (`?lsel=`): set by deep-links (e.g. a Scout-routed improvement
  // click) — the row is highlighted + scrolled into view; clicking it dismisses.
  const [lsel, setLsel] = useQueryState("lsel", parseAsString);
  // Absorbed from the retired Ideas view, both URL state so an agent can drive
  // them through ui:dispatch: the rail facet and the pipeline-trace expansion.
  const [railFilter, setRailFilter] = useQueryState("irail", parseAsString);
  const [traceOpen, setTraceOpen] = useQueryState("itrace", parseAsString);

  // ── Grading, absorbed from the Ideas view. The note popover's open-state is
  // URL state (`?grade=<ideaId>`) so agents can drive it; in-flight optimistic
  // grades and errors are transient lifecycle, so they stay in useState. A
  // grade from this surface is an OWNER grade (the server derives gradedBy from
  // the caller), and owner regrade is always allowed, so the stars stay
  // interactive on already-graded rows.
  //
  // This is the ONLY control on a row, by owner ruling: in a full-auto loop the
  // human teaches the generator and does not approve the work ["the learning
  // loops is designed to be full auto so needs a call makes no sense" — owner
  // 2026-07-27].
  const [gradeOpen, setGradeOpen] = useQueryState("grade", parseAsString);
  const [optimistic, setOptimistic] = useState<Record<string, EffectiveGrade>>(
    {},
  );
  const [savingId, setSavingId] = useState("");
  const [gradeError, setGradeError] = useState("");
  const effectiveGrade = useCallback(
    (idea: ScoutRoutedItem): EffectiveGrade | null => {
      const opt = optimistic[idea.ideaId];
      if (opt) return opt;
      if (idea.humanGrade == null) return null;
      return {
        grade: idea.humanGrade,
        feedback: idea.humanFeedback ?? null,
        gradedBy: idea.gradedBy ?? "owner",
      };
    },
    [optimistic],
  );
  const submitGrade = async (
    idea: ScoutRoutedItem,
    grade: number,
    feedback: string | null,
  ) => {
    setGradeError("");
    setSavingId(idea.ideaId);
    const prevEntry = optimistic[idea.ideaId] ?? null;
    // Optimistic: show the new grade immediately; the refetched snapshot
    // confirms it (or the catch below rolls it back).
    setOptimistic((m) => ({
      ...m,
      [idea.ideaId]: { grade, feedback, gradedBy: "owner" },
    }));
    try {
      const res = await fetch("/api/agent-tools/scout/grade-idea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ideaId: idea.ideaId,
          grade,
          ...(feedback ? { feedback } : {}),
        }),
      });
      const raw: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = unwrapToolResult(raw);
      if (result.applied === false)
        throw new Error(String(result.reason ?? "grade not applied"));
      scoutSync.invalidate();
    } catch (e) {
      setOptimistic((m) => {
        const next = { ...m };
        if (prevEntry) next[idea.ideaId] = prevEntry;
        else delete next[idea.ideaId];
        return next;
      });
      setGradeError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId("");
    }
  };

  // ── Deep-links out of a trace (all nuqs, so ui:dispatch can drive the same
  // navigation). The merge simplifies the common case: an idea that routed to a
  // work item no longer navigates ANYWHERE — its work is a row on this very
  // list, so "open it" means select it here.
  const [, setTab] = useQueryState("tab", parseAsString);
  const [, setCreateView] = useQueryState("view", parseAsString);
  const [, setPlanSel] = useQueryState("plan", parseAsString);
  const [, setLviewTarget] = useQueryState("lview", parseAsString);
  const [, setTopBarSlug] = useQueryState("slug", parseAsString);
  const openPlan = useCallback(
    (slug: string) => {
      void setPlanSel(slug);
      void setCreateView("plans");
      void setTab("plans");
    },
    [setCreateView, setPlanSel, setTab],
  );
  // Select a work item ON THIS LIST, clearing the facets that could hide it —
  // a sticky lane or rail filter would swallow the click and read as a no-op.
  const openImprovement = useCallback(
    (id: string) => {
      void setLsel(id);
      void setLane(null);
      void setSrc(null);
      void setRailFilter(null);
    },
    [setLane, setLsel, setRailFilter, setSrc],
  );
  const openRouted = useCallback(
    (idea: ScoutRoutedItem) => {
      if (idea.rail === "plan" && idea.routedRef.startsWith("plan:")) {
        openPlan(idea.routedRef.slice("plan:".length));
      } else if (idea.rail === "gym") {
        // WI-5412: carry the idea's hive so the Gym opens on the seed's data.
        // The ledger doesn't stamp harness_slug consistently (EI-10520) — treat
        // absence as unknown and navigate without touching the selection.
        if (idea.harnessSlug) void setTopBarSlug(idea.harnessSlug);
        void setLviewTarget("gym");
      } else if (idea.rail === "instance") {
        void setLviewTarget("benchmark");
      } else {
        openImprovement(
          idea.routedRef.startsWith("wi:")
            ? idea.routedRef.slice("wi:".length)
            : idea.routedRef,
        );
      }
    },
    [openImprovement, openPlan, setLviewTarget, setTopBarSlug],
  );

  // ── The join. An idea records the artifact it became as a typed ref, so a
  // work-item routing is "wi:EI-…" and the two halves key on the work-item id.
  // An idea can be re-routed to the same item; keep the newest routing.
  const ideaByItemId = useMemo(() => {
    const byId = new Map<string, ScoutRoutedItem>();
    for (const idea of routed) {
      if (!idea.routedRef.startsWith("wi:")) continue;
      const id = idea.routedRef.slice("wi:".length);
      const prev = byId.get(id);
      if (!prev || (idea.routedAt ?? "") > (prev.routedAt ?? ""))
        byId.set(id, idea);
    }
    return byId;
  }, [routed]);

  const allRows = useMemo<LoopRow[]>(() => {
    const nowMs = Date.now();
    const base = !digest
      ? []
      : lane === "auto"
        ? digest.autoEligible
        : lane === "human"
          ? digest.humanQueue
          : [...digest.autoEligible, ...digest.humanQueue];
    const workRows: LoopRow[] = base.map((item) => ({
      key: item.id,
      item,
      idea: ideaByItemId.get(item.id) ?? null,
    }));
    // Ideas with no work-item row of their own — routed to a plan/gym/benchmark
    // rail, or not yet filed at all. These are the loop's output BEFORE it
    // becomes work, and the owner named them explicitly as in scope.
    //
    // The lane facet (auto-fixable / needs-review) is a WORK-ITEM triage
    // decision, so an idea-only row cannot satisfy it — selecting a lane
    // excludes them rather than showing rows the filter never judged. The
    // column filters need no such rule: their accessors read through `item`
    // and report "—" here, so an idea-only row drops out of a severity or
    // state filter on its own.
    const filed = new Set(workRows.map((row) => row.item?.id));
    const ideaRows: LoopRow[] =
      lane === "all"
        ? routed
            .filter((idea) => {
              if (!idea.routedRef.startsWith("wi:")) return true;
              return !filed.has(idea.routedRef.slice("wi:".length));
            })
            .map((idea) => ({ key: idea.ideaId, item: null, idea }))
        : [];
    // Most-recent first across BOTH halves. Work items carry a fractional
    // `ageDays` from the digest and ideas a routing instant, so age-in-days is
    // the one key both can answer; the sequential id suffix (the old Backlog
    // sort) stays as the tie-break for same-instant captures.
    const idNum = (s: string) => {
      const n = parseInt(s.split("-").pop() ?? "", 10);
      return Number.isFinite(n) ? n : 0;
    };
    return [...workRows, ...ideaRows].sort((a, b) => {
      const d = rowAgeDays(a, nowMs) - rowAgeDays(b, nowMs);
      if (Math.abs(d) > 1e-9) return d;
      return idNum(b.item?.id ?? b.key) - idNum(a.item?.id ?? a.key);
    });
  }, [digest, ideaByItemId, lane, routed]);

  const sources = useMemo<string[]>(() => {
    const s = new Set<string>();
    for (const it of [
      ...(digest?.autoEligible ?? []),
      ...(digest?.humanQueue ?? []),
    ]) {
      if (it.source) s.add(it.source);
    }
    return [...s].sort();
  }, [digest]);

  const rows = useMemo<LoopRow[]>(() => {
    let out = allRows;
    // Who filed it (`?lsrc=`) — a chip row in the scope bar rather than the old
    // dropdown, so the provenance split is readable without opening a menu.
    if (src) out = out.filter((row) => row.item?.source === src);
    // Which rail the idea routed into (`?irail=`, absorbed from Ideas). A rail
    // is a property of the IDEA, so filtering by one necessarily narrows to
    // idea-bearing rows — that is the question being asked.
    if (railFilter) out = out.filter((row) => row.idea?.rail === railFilter);
    return out;
  }, [allRows, railFilter, src]);
  // The small-queue path: no dashboard, no facets, just the list. It must span
  // BOTH halves — a pot with routed ideas but nothing filed yet has a perfectly
  // non-empty Improve list, and rendering only the work items there would show
  // "the loop has not produced anything" while sitting on the loop's output.
  // (It ignores the lane facet by design: sparse mode renders no lane control.)
  const sparseRows = useMemo<LoopRow[]>(() => {
    const items = [
      ...(digest?.autoEligible ?? []),
      ...(digest?.humanQueue ?? []),
    ];
    const filed = new Set(items.map((item) => item.id));
    return [
      ...items.map((item) => ({
        key: item.id,
        item,
        idea: ideaByItemId.get(item.id) ?? null,
      })),
      ...routed
        .filter((idea) => {
          if (!idea.routedRef.startsWith("wi:")) return true;
          return !filed.has(idea.routedRef.slice("wi:".length));
        })
        .map((idea) => ({ key: idea.ideaId, item: null, idea })),
    ];
  }, [digest, ideaByItemId, routed]);
  // Shared column filters + quick-search (owner ask 2026-07-19: mimic the
  // Working tab's Work Queue): the shared filter engine (`impf` param) over
  // the lane/source-scoped rows, plus a global substring quick-search
  // (`impq`) as its own affordance — the same split WorkItemsPanel uses.
  const [search, setSearch] = useQueryState(
    "impq",
    parseAsString.withDefault(""),
  );
  // Accessors read THROUGH the work-item half: an idea-only row answers "—" to
  // every work-item column, so it drops out of any such filter by itself, and
  // the lens column is the one facet an idea-only row can actually answer.
  const filterCols = useMemo<FilterableColumn<LoopRow>[]>(
    () => [
      { key: "kind", header: "Kind", filter: { type: "enum", accessor: (r) => r.item?.kind ?? "—" } },
      { key: "severity", header: "Severity", filter: { type: "enum", accessor: (r) => r.item?.severity ?? "—" } },
      { key: "scope", header: "Scope", filter: { type: "enum", accessor: (r) => r.item?.scope ?? "—" } },
      // ONE stage facet (P-004), over the same words the row chip shows.
      // It replaces two facets that could not survive the vocabulary change:
      // `tier` (auto/human) sliced by a human-approval gate that no longer
      // exists and is no longer displayed anywhere — you cannot filter by an
      // invisible property; `state` exposed the raw storage lifecycle, and
      // since the digest admits only OPEN items it offered exactly one choice.
      {
        key: "stage",
        header: "Stage",
        filter: { type: "enum", accessor: (r) => PIPELINE_STATES[pipelineState(r)].label },
      },
      { key: "ideaType", header: "Idea type", filter: { type: "enum", accessor: (r) => r.item?.ideaType ?? "—" } },
      { key: "lens", header: "Lens", filter: { type: "enum", accessor: (r) => r.idea?.lens ?? "—" } },
      { key: "score", header: "Score", filter: { type: "number", accessor: (r) => r.item?.score ?? 0 } },
      { key: "ageDays", header: "Age (days)", filter: { type: "number", accessor: (r) => r.item?.ageDays ?? 0 } },
    ],
    [],
  );
  const cf = useColumnFilters(filterCols, rows, { ns: "imp" });
  const visibleRows = useMemo(() => {
    const q = (search ?? "").trim().toLowerCase();
    if (!q) return cf.rows;
    // Search spans BOTH halves — an idea's title is often the only text an
    // as-yet-unfiled row has.
    return cf.rows.filter((row) =>
      `${row.item?.id ?? ""} ${row.item?.title ?? ""} ${row.item?.tierReason ?? ""} ${row.item?.scope ?? ""} ${row.idea?.title ?? ""} ${row.idea?.lens ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [cf.rows, search]);
  const isFiltered =
    cf.hasActive ||
    (search ?? "").trim() !== "" ||
    Boolean(src) ||
    Boolean(railFilter);

  // Everything a row needs, bundled once. A merged row draws on both halves of
  // the view's state (selection, trace, grading, navigation), and threading a
  // dozen props through the windowed list is how one of them silently goes
  // stale — the row components take this object and nothing else.
  // Deliberately NOT memoized: `onGrade` is a per-render closure over the
  // in-flight grade state, so a dependency list would either omit it (and
  // capture a stale rollback snapshot) or change every render anyway. The row
  // components are not memo()'d, so a fresh object costs nothing.
  const rowCtx: LoopRowContext = {
    railMetaMap: RAIL_META,
    groundingTitles,
    brainWord: t("brain"),
    traceOpen,
    onToggleTrace: (id) => void setTraceOpen(id),
    gradeOpen,
    onGradeOpenChange: (id) => void setGradeOpen(id),
    effectiveGrade,
    onGrade: submitGrade,
    savingId,
    onOpenRouted: openRouted,
    onOpenPlan: openPlan,
    onOpenImprovement: openImprovement,
    onDismissSelect: () => void setLsel(null),
  };

  const resolved = digest?.byState?.resolved ?? 0;
  const showDashboard = (digest?.open ?? 0) >= 4;
  // The badge reports whether the LOOP is healthy, not whether the pile is big.
  // The drift markers (single-lens collapse, budget-exhausted streak, grading
  // starvation) are server-evaluated against the blender-release-readiness
  // rubric — they are the health spec, so they win over any row count here.
  //
  // The old "humanQueue is non-empty ⇒ warn" rule is deliberately GONE: it
  // nagged about a review queue the human is not supposed to action ["the
  // learning loops is designed to be full auto so needs a call makes no sense"
  // — owner 2026-07-27]. Retiring the queue's remaining vocabulary is P-004.
  useEffect(() => {
    onStatus?.(
      sync.error || scoutSync.error
        ? "bad"
        : health.status !== "neutral"
          ? health.status
          : !digest
            ? "neutral"
            : digest.open === 0
              ? "good"
              : "neutral",
    );
  }, [digest, health.status, onStatus, scoutSync.error, sync.error]);

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Sparkles}
        title="Improve"
        question="What the learning loop produced — each idea and the work it became. Grading an idea is what teaches the generator."
        signal={digest ? `${digest.open} open` : undefined}
        tone={
          health.status !== "neutral"
            ? health.status
            : digest && digest.open === 0
              ? "good"
              : "accent"
        }
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the improve feed"
            disabled={sync.fetching || scoutSync.fetching}
            onClick={() => {
              sync.invalidate();
              scoutSync.invalidate();
            }}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {/* ONE plain-language glance line, absorbed from the Ideas view: what the
          loop produced, what is still open, and when it next fires. Every gauge
          stays behind the labelled disclosure below. */}
      <p className="pc-learning__glance" aria-label="The loop at a glance">
        <span title="Every idea a cycle turned into an artifact (work item, plan, gym seed, benchmark).">
          <strong>{snap?.totalRouted ?? 0}</strong> ideas
        </span>
        {digest ? (
          <span title={`${PIPELINE_STATES.approved.desc} Includes work already in flight.`}>
            <strong>{digest.open}</strong> in the queue
          </span>
        ) : null}
        {snap?.improveFunnel ? (
          <span title={PIPELINE_STATES.shipped.desc}>
            <strong>{snap.improveFunnel.done}</strong> {PIPELINE_STATES.shipped.label}
          </span>
        ) : null}
        {health.markers.length > 0 ? (
          <span
            className="is-warn"
            title={health.markers
              .map((m) => `${m.key.replace(/-/g, " ")}: ${m.summary}`)
              .join("\n")}
          >
            <AlertTriangle size={11} aria-hidden />
            {health.markers.length} loop warning
            {health.markers.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </p>

      {/* ── The scope bar. THE control that makes this list honest.
          Measured 2026-07-27: 8,202 rows — 99.93% of the old Backlog — were
          also on the Work tab, because this read applied no provenance filter
          at all. Scoping to the loop's own output is the default; everything
          else is one click away, and the way OUT is stated rather than left
          for the reader to wonder about. */}
      <div className="pc-learning__idea-filters" aria-label="Where these came from">
        <Tooltip label="Only what the learning loop produced: ideas, and the work items they became.">
          <button
            type="button"
            aria-pressed={scope === "loop"}
            onClick={() => void setScope("loop")}
          >
            <Radar size={11} aria-hidden />
            From the loop{" "}
            {digest && scope === "loop" ? <strong>{digest.total}</strong> : null}
          </button>
        </Tooltip>
        {sources.map((s) => (
          <Tooltip key={s} label={`Filed by ${s}`}>
            <button
              type="button"
              aria-pressed={src === s}
              onClick={() => void setSrc(src === s ? null : s)}
            >
              {s}
            </button>
          </Tooltip>
        ))}
        <Tooltip label="Every capture in this workspace, including work that never came from the loop — the same population the Work tab lists.">
          <button
            type="button"
            aria-pressed={scope === "all"}
            onClick={() => void setScope("all")}
          >
            Every capture
          </button>
        </Tooltip>
        {scope === "loop" ? (
          <span
            className="pc-learning__matchcount"
            title="Captures that did not come from the learning loop are work, not learning — they live on the Work tab."
          >
            work not from the loop lives in Work →
          </span>
        ) : null}
      </div>

      {/* Every gauge behind ONE labelled disclosure: the cycle engine that
          makes ideas, and the capture/resolve flow that burns them down. */}
      <LearningDisclosure
        label="How the loop is doing"
        subtitle="what fires a cycle, the recent runs, and whether capture and resolve keep pace"
      >
        <LoopEngineInstruments snap={snap} scoutWord={t("scout")} />
        {digest?.flow ? <FlowStrip flow={digest.flow} /> : null}
        <LearningEfficacyPanel />
      </LearningDisclosure>

      <LensWeights snap={snap} scoutWord={t("scout")} />

      {/* Rail facet — where each idea routed. Sits directly above the list it
          filters (owner ask 2026-07-19). */}
      {snap && rails.length > 0 ? (
        <div className="pc-learning__idea-filters" aria-label="Idea routing">
          <button
            type="button"
            aria-pressed={!railFilter}
            onClick={() => void setRailFilter(null)}
          >
            <Radar size={11} aria-hidden />
            All rails <strong>{snap.totalRouted}</strong>
          </button>
          {rails.map((rail) => {
            const meta = RAIL_META[rail.rail];
            return (
              <Tooltip key={rail.rail} label={meta?.desc}>
                <button
                  type="button"
                  aria-pressed={railFilter === rail.rail}
                  onClick={() =>
                    void setRailFilter(
                      railFilter === rail.rail ? null : rail.rail,
                    )
                  }
                >
                  <i style={{ background: meta?.color }} aria-hidden />
                  {meta?.label ?? rail.rail} <strong>{rail.count}</strong>
                </button>
              </Tooltip>
            );
          })}
        </div>
      ) : null}

      {digest && showDashboard ? (
        // The header signal already carries the headline "N open"; this line is the
        // pipeline breakdown, with Review the one accent (only when it needs eyes).
        <LearningStatLine
          stats={[
            { label: "Captured", value: digest.total },
            { label: "Automatic", value: digest.autoEligible.length },
            {
              label: "Review",
              value: digest.humanQueue.length,
              tone: digest.humanQueue.length > 0 ? "warn" : undefined,
            },
            { label: "Resolved", value: resolved },
          ]}
        />
      ) : null}

      {showDashboard ? (
        <div className="pc-learning__sectionhead pc-learning__sectionhead--tools">
          <div className="pc-learning__inlinetools">
            <label className="pc-learning__search">
              <Search size={12} aria-hidden />
              <input
                type="text"
                value={search ?? ""}
                onChange={(e) => void setSearch(e.target.value)}
                placeholder="Search ideas and work…"
                aria-label="Search ideas and work"
              />
            </label>
            <ColumnFilterBar
              controller={cf.controller}
              activeChips={cf.activeChips}
              hasActive={cf.hasActive}
              clearAll={cf.clearAll}
            />
            <span
              className="pc-learning__matchcount"
              aria-live="polite"
              title={
                isFiltered
                  ? "Rows matching the current filter / search, out of everything in scope."
                  : "Rows in scope — ideas and the work they became."
              }
            >
              {isFiltered
                ? `${visibleRows.length} of ${allRows.length}`
                : `${rows.length} items`}
            </span>
            {/* The "who filed it" facet is now a chip in the scope bar above —
                provenance is the headline question on this surface, not a
                dropdown to open. */}
            <div
              className="pc-learning__lanes"
              role="tablist"
              aria-label="Triage lane"
            >
              {LANES.filter(
                (l) =>
                  l === "all" ||
                  (l === "auto"
                    ? (digest?.autoEligible.length ?? 0) > 0
                    : (digest?.humanQueue.length ?? 0) > 0),
              ).map((l) => (
                <Tooltip
                  key={l}
                  label={
                    l === "auto"
                      ? "Bugs agents may fix on their own"
                      : l === "human"
                        ? "Items waiting on your judgment"
                        : null
                  }
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={lane === l}
                    className={`pc-learning__lane${lane === l ? " is-active" : ""}`}
                    onClick={() => void setLane(l)}
                  >
                    {l === "all"
                      ? "All"
                      : l === "auto"
                        ? "Auto-fixable"
                        : "Needs review"}
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {gradeError ? (
        <p className="pc-learning__empty" role="alert">
          Grade failed: {gradeError}
        </p>
      ) : null}

      {sync.loading && !digest ? (
        <p className="pc-learning__empty">Loading what the loop produced…</p>
      ) : sync.error ? (
        <LearningVisualError
          title="Improve unavailable"
          onRetry={() => sync.invalidate()}
        />
      ) : (showDashboard ? visibleRows : sparseRows).length === 0 ? (
        <LearningVisualEmpty
          icon={CheckCircle2}
          title={
            isFiltered
              ? "Nothing matches the current filter / search"
              : "The loop has not produced anything here yet"
          }
          body={
            isFiltered
              ? undefined
              : `The ${t("scout")} reads this ${t("pot", { lower: true })}'s history on a cadence and routes surviving ideas here — cycles usually appear within the hour once armed.`
          }
          action={isFiltered ? undefined : { label: "Open Arming", onClick: openArming }}
        />
      ) : !showDashboard ? (
        <ul className="pc-learning__list pc-learning__list--direct">
          {sparseRows.map((row) => (
            <LoopRowView
              key={row.key}
              row={row}
              ctx={rowCtx}
              selected={isSelectedRow(row, lsel)}
            />
          ))}
        </ul>
      ) : (
        <WindowedImprovementList rows={visibleRows} lsel={lsel} ctx={rowCtx} />
      )}

      {/* Drafts in iteration (learning-tab-visibility P-005; moved here from
          the Ideas view, owner ask 2026-07-19): broad-scope ideas that became
          draft plans, with their revision state — the Queen↔Scout
          typed-revision loop, watchable instead of invisible. */}
      {draftsFault.failed ? (
        // Deliberately a quiet inline note, NOT a LearningVisualError: this is a
        // SECONDARY read, and blanking the primary improvements list because a
        // side section failed would be a worse lie than the one being fixed.
        // Honest and small beats loud and disproportionate.
        <p className="pc-learning__quietempty">
          {draftsFault.message ?? "Drafts in iteration unavailable"}
        </p>
      ) : drafts.length > 0 ? (
        <LearningDisclosure
          label="Drafts in iteration"
          subtitle="broad ideas that became draft plans, with revision state"
          count={drafts.length}
        >
          <ul
            className="pc-learning__draftlist"
            aria-label={`${t("scout")} draft plans in iteration`}
          >
            {drafts.map((d) => {
              const upMs = d.planUpdatedAt ? Date.parse(d.planUpdatedAt) : NaN;
              return (
                <li key={d.ideaId} className="pc-learning__draftrow">
                  <GitBranch size={11} aria-hidden />
                  <strong title={d.title ?? d.planSlug}>{d.planSlug}</strong>
                  {d.planStatus == null ? (
                    <em title="The draft plan row no longer exists (superseded or deleted).">gone</em>
                  ) : (
                    <em title={`Draft plan lifecycle status.`}>{d.planStatus}</em>
                  )}
                  {d.planVersion != null ? (
                    <span
                      className={`pc-learning__flowchip${d.revised ? " pc-learning__flowchip--wd-good" : ""}`}
                      title={
                        d.revised
                          ? `v${d.planVersion} — revised since ${t("scout", { lower: true })} drafted it: the grade/feedback → typed-revision loop has turned on this draft.`
                          : "v1 — no revision yet; awaiting review/feedback."
                      }
                    >
                      v{d.planVersion}
                      {d.revised ? " · revised" : ""}
                    </span>
                  ) : null}
                  {!Number.isNaN(upMs) ? (
                    <span className="pc-learning__draftwhen">
                      {whenLabel(upMs)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </LearningDisclosure>
      ) : null}
    </section>
  );
}

/** First page renders immediately; the long tail mounts only on demand
 *  (WI-5412 perf: ~380 un-virtualized rows mounted at once was a real slice of
 *  the first-click cost). The deep-link target (?lsel) is hoisted into the
 *  first page so a selection is never hidden behind the disclosure. */
const IMPROVEMENTS_PAGE = 60;

/** Everything a merged row needs from the view, in one object — see the note at
 *  its construction site for why it is passed whole rather than as props. */
interface LoopRowContext {
  railMetaMap: ReturnType<typeof railMeta>;
  /** Server-resolved titles for the opaque `wi:` grounding refs. */
  groundingTitles: Record<string, string>;
  /** Lexicon word for the grading brain — packs rename it. */
  brainWord: string;
  traceOpen: string | null;
  onToggleTrace: (ideaId: string | null) => void;
  gradeOpen: string | null;
  onGradeOpenChange: (ideaId: string | null) => void;
  effectiveGrade: (idea: ScoutRoutedItem) => EffectiveGrade | null;
  onGrade: (
    idea: ScoutRoutedItem,
    grade: number,
    feedback: string | null,
  ) => Promise<void>;
  savingId: string;
  onOpenRouted: (idea: ScoutRoutedItem) => void;
  onOpenPlan: (slug: string) => void;
  onOpenImprovement: (id: string) => void;
  onDismissSelect: () => void;
}

function WindowedImprovementList({
  rows,
  lsel,
  ctx,
}: {
  rows: LoopRow[];
  lsel: string | null;
  ctx: LoopRowContext;
}) {
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 140,
    overscan: 5,
  });

  return (
    <ul 
      className="pc-learning__list" 
      style={{
        position: 'relative',
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
      }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const row = rows[virtualItem.index];
        return (
          <LoopRowView
            key={row.key}
            row={row}
            ctx={ctx}
            selected={isSelectedRow(row, lsel)}
            index={virtualItem.index}
            measureRef={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          />
        );
      })}
    </ul>
  );
}

/**
 * The pipeline trace: an idea's whole loop as one stack of stages — grounding
 * evidence → lens → routed artifact → grade → outcome. Every field comes from
 * the same ledger read the list renders, and a missing stage renders dimmed
 * because THE GAP IS THE SIGNAL (an "ungraded" row on a starving grading loop
 * is the finding, not a rendering hole to paper over).
 */
function IdeaTrace({
  idea,
  ctx,
}: {
  idea: ScoutRoutedItem;
  ctx: LoopRowContext;
}) {
  const meta = ctx.railMetaMap[idea.rail] ?? {
    label: idea.rail,
    desc: "Routed idea",
    color: "#94a3b8",
  };
  const refs = idea.addressesPatternRefs ?? [];
  const eff = ctx.effectiveGrade(idea);
  const outcome = idea.outcome ?? "pending";
  const outcomeTone =
    outcome === "won" ? "good" : outcome === "lost" ? "bad" : "missing";
  // Display the ref WITHOUT its rail prefix — the rail chip already names the
  // destination (owner ask 2026-07-19: "gym gym:SP-004" doubles were unreadable).
  const shortRef = idea.routedRef.replace(/^[a-z]+:/i, "");

  const groundingChip = (ref: string) => {
    const sep = ref.indexOf(":");
    const kind = sep > 0 ? ref.slice(0, sep) : "ref";
    const rest = sep > 0 ? ref.slice(sep + 1) : ref;
    if (kind === "wi") {
      const title = ctx.groundingTitles[ref];
      return (
        <Tooltip
          key={ref}
          label={title ? `${rest} — ${title} (select in this list)` : `${rest} — select in this list`}
        >
          <button
            type="button"
            className="pc-learning__tracechip pc-learning__tracechip--link"
            onClick={() => ctx.onOpenImprovement(rest)}
          >
            <i>{kind}</i>
            <span className="pc-learning__tracechip-text">{title ?? rest}</span>
          </button>
        </Tooltip>
      );
    }
    if (kind === "plan") {
      return (
        <Tooltip key={ref} label={`${rest} — open the plan in Create → Plans`}>
          <button
            type="button"
            className="pc-learning__tracechip pc-learning__tracechip--link"
            onClick={() => ctx.onOpenPlan(rest)}
          >
            <i>{kind}</i>
            <span className="pc-learning__tracechip-text">{rest}</span>
          </button>
        </Tooltip>
      );
    }
    return (
      <span key={ref} className="pc-learning__tracechip" title={ref}>
        <i>{kind}</i>
        <span className="pc-learning__tracechip-text">{rest}</span>
      </span>
    );
  };

  return (
    <div
      className="pc-learning__trace"
      aria-label={`Pipeline trace for ${idea.title ?? idea.routedRef}`}
    >
      <div
        className={`pc-learning__tracerow${refs.length === 0 ? " is-missing" : ""}`}
      >
        <em>grounded in</em>
        <span className="pc-learning__tracechips">
          {refs.length > 0 ? (
            refs.map(groundingChip)
          ) : (
            <strong title="No grounding evidence was recorded for this idea (su-ideate filings often ground informally).">
              none recorded
            </strong>
          )}
        </span>
      </div>
      <div className="pc-learning__tracerow">
        <em>lens</em>
        <strong
          title={
            idea.cycleId
              ? `Produced by the '${idea.lens}' lens in cycle ${idea.cycleId}`
              : `Produced by the '${idea.lens}' lens`
          }
        >
          {idea.lens}
          {idea.origin ? <i> · {idea.origin}</i> : null}
        </strong>
      </div>
      <div className="pc-learning__tracerow">
        <em>routed to</em>
        <span className="pc-learning__tracechips">
          <Tooltip label={`${meta.desc} — open ${idea.routedRef}`}>
            <button
              type="button"
              className="pc-learning__tracechip pc-learning__tracechip--link"
              onClick={() => ctx.onOpenRouted(idea)}
            >
              <i
                className="pc-learning__tracedot"
                style={{ background: meta.color }}
                aria-hidden
              />
              <span>{meta.label}</span>
              <b className="pc-learning__tracechip-text">{shortRef}</b>
            </button>
          </Tooltip>
        </span>
      </div>
      <div className={`pc-learning__tracerow${eff ? "" : " is-missing"}`}>
        <em>grade</em>
        <strong
          title={
            eff
              ? (eff.feedback ?? `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}`)
              : "Ungraded — the grade→learn half of the loop has not seen this idea."
          }
        >
          {eff
            ? `★${eff.grade} · ${graderLabel(eff.gradedBy, ctx.brainWord)}`
            : "ungraded"}
        </strong>
      </div>
      <div
        className={`pc-learning__tracerow${outcomeTone === "missing" ? " is-missing" : ` is-${outcomeTone}`}`}
      >
        <em>outcome</em>
        <strong title="Outcome derived from the change feed (won / lost / pending) — did the routed artifact pan out?">
          {outcome}
        </strong>
      </div>
    </div>
  );
}

/**
 * One row of the merged list: the idea, the work it became, or both.
 *
 * The two old rows were near-identical shapes over the same population — the
 * Ideas row led with a rail and carried a grade, the Backlog row led with a
 * severity and carried a triage score. This renders whichever halves the row
 * actually has, so an idea that became work reads as ONE thing with one origin
 * and one fate, rather than as two rows on two tabs that never referenced each
 * other.
 */
function LoopRowView({
  row,
  ctx,
  selected = false,
  index,
  measureRef,
  style,
}: {
  row: LoopRow;
  ctx: LoopRowContext;
  /** Deep-link target (?lsel) — highlighted + scrolled into view; click dismisses. */
  selected?: boolean;
  /** Virtualized row index required by TanStack's measurement callback. */
  index?: number;
  /** Optional TanStack callback used by the windowed list to measure this row. */
  measureRef?: (element: HTMLLIElement | null) => void;
  /** Absolute-positioning style supplied by the windowed list. */
  style?: CSSProperties;
}) {
  const { item, idea } = row;
  const meta = idea
    ? (ctx.railMetaMap[idea.rail] ?? {
        label: idea.rail,
        desc: "Routed idea",
        color: "#94a3b8",
      })
    : null;
  const sevColor = item ? SEVERITY[item.severity ?? "minor"].solid : null;
  const stage = pipelineState(row);
  const eff = idea ? ctx.effectiveGrade(idea) : null;
  const isTraceOpen = Boolean(idea) && ctx.traceOpen === idea?.ideaId;
  const isGradeOpen = Boolean(idea) && ctx.gradeOpen === idea?.ideaId;
  const saving = Boolean(idea) && ctx.savingId === idea?.ideaId;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected]);

  const combinedRef = useCallback((el: HTMLLIElement | null) => {
    ref.current = el;
    measureRef?.(el);
  }, [measureRef]);

  // The leading id: the work item when there is one (it is the thing you act
  // on), otherwise the rail the idea went to.
  const leadLabel = item ? item.id : (meta?.label ?? "idea");
  const leadColor = item ? undefined : meta?.color;
  const title = item?.title ?? idea?.title ?? idea?.routedRef ?? "";

  return (
    <li
      ref={combinedRef}
      data-index={index}
      style={style}
      className={`pc-learning__row${selected ? " pc-learning__row--selected" : ""}`}
      // No row-level `title`: it used to carry `tierReason` ("… → human
      // review"), which now contradicts the stage chip's own tooltip. The chip
      // explains where the row is; nothing else on the row should re-explain it
      // in the retired approval vocabulary.
      onClick={selected ? ctx.onDismissSelect : undefined}
    >
      <span
        className="pc-learning__sev"
        style={{ background: sevColor ?? meta?.color ?? "#94a3b8" }}
        aria-hidden
      />
      {idea ? (
        // Only an idea-bearing row is expandable — the trace IS the idea's
        // record, so a capture with no idea behind it has nothing to expand.
        <Tooltip
          label={
            isTraceOpen
              ? "Hide this idea's trace"
              : "Show where this came from — grounding, lens, route, grade, outcome"
          }
        >
          <button
            type="button"
            className="pc-learning__rowmain"
            aria-expanded={isTraceOpen}
            onClick={() =>
              ctx.onToggleTrace(isTraceOpen ? null : idea.ideaId)
            }
          >
            <span className="pc-learning__id" style={{ color: leadColor }}>
              {leadLabel}
            </span>
            <span className="pc-learning__title">{title}</span>
          </button>
        </Tooltip>
      ) : (
        <>
          <span className="pc-learning__id">{leadLabel}</span>
          <span className="pc-learning__title">{title}</span>
        </>
      )}
      <span className="pc-learning__meta">
        {idea ? (
          <span
            className="pc-learning__chip pc-learning__chip--idea"
            style={{ color: lensColor(idea.lens), borderColor: lensColor(idea.lens) }}
            title="The creative lens that produced this idea"
          >
            {idea.lens}
          </span>
        ) : null}
        {item ? (
          <span
            className="pc-learning__chip"
            style={{ color: sevColor ?? undefined, borderColor: sevColor ?? undefined }}
          >
            {item.severity ?? "—"}
          </span>
        ) : null}
        {item?.ideaType ? (
          <span className="pc-learning__chip pc-learning__chip--idea">
            {item.ideaType}
          </span>
        ) : null}
        {item?.source ? (
          <span className="pc-learning__chip" title={`Filed by ${item.source}`}>
            {item.source}
          </span>
        ) : null}
        {/* Where this is in the loop (P-004). ONE chip, one vocabulary, on
            every row — replacing the old review/auto pair, which announced a
            human approval gate that does not exist. */}
        <span
          className={`pc-learning__chip pc-learning__chip--stage-${stage}`}
          title={PIPELINE_STATES[stage].desc}
        >
          {PIPELINE_STATES[stage].label}
        </span>
        <span className="pc-learning__age" title="How long ago this was filed">
          {item
            ? ageLabel(item.ageDays)
            : idea?.routedAt
              ? whenLabel(Date.parse(idea.routedAt))
              : ""}
        </span>
        {item ? (
          <span
            className="pc-learning__score"
            title="Triage priority (severity + age) — higher means more urgent"
          >
            {item.score}
          </span>
        ) : null}
        {/* The ONLY control on a row (owner ruling 2026-07-27): in a full-auto
            loop the human teaches the generator, never approves the work. */}
        {idea ? (
          <span
            className="pc-learning__grade"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {eff ? (
              <span
                className="pc-learning__gradechip"
                title={
                  eff.feedback
                    ? `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}: “${eff.feedback}”`
                    : `Graded by ${graderLabel(eff.gradedBy, ctx.brainWord)}`
                }
              >
                ★{eff.grade} · {graderLabel(eff.gradedBy, ctx.brainWord)}
              </span>
            ) : null}
            <Popover
              open={isGradeOpen}
              onOpenChange={(open) =>
                ctx.onGradeOpenChange(open ? idea.ideaId : null)
              }
              trigger={
                <button
                  type="button"
                  className="pc-learning__notebtn"
                  aria-label={eff ? "Review idea grade" : "Grade this idea"}
                  aria-expanded={isGradeOpen}
                >
                  {eff ? (
                    <Star size={12} fill="currentColor" aria-hidden />
                  ) : (
                    <MessageSquarePlus size={12} aria-hidden />
                  )}
                </button>
              }
              tooltipLabel={eff ? "Review this grade" : "Grade this idea"}
              ariaLabel={`Grade ${title}`}
              contentClassName="pc-learning__gradepopover"
            >
              <GradePanel
                current={eff}
                busy={saving}
                onSave={(grade, feedback) => {
                  void ctx
                    .onGrade(idea, grade, feedback)
                    .then(() => ctx.onGradeOpenChange(null));
                }}
                onClose={() => ctx.onGradeOpenChange(null)}
              />
            </Popover>
          </span>
        ) : null}
      </span>
      {isTraceOpen && idea ? <IdeaTrace idea={idea} ctx={ctx} /> : null}
    </li>
  );
}

// ─── Flow strip (P-041 — flows, not stocks) ──────────────────────────────────

/** Watchdog liveness tone: green <30min since the last tick, amber <2h, red otherwise (incl. never). */
function watchdogHealth(
  lastTickAt: string | null,
  nowMs: number,
): { tone: "good" | "warn" | "bad"; label: string } {
  const ms = lastTickAt ? Date.parse(lastTickAt) : NaN;
  if (Number.isNaN(ms)) return { tone: "bad", label: "never" };
  const ageMin = Math.max(0, (nowMs - ms) / 60_000);
  const label =
    ageMin < 1
      ? "just now"
      : ageMin < 90
        ? `${Math.round(ageMin)}m ago`
        : ageMin < 48 * 60
          ? `${Math.round(ageMin / 60)}h ago`
          : `${Math.round(ageMin / (60 * 24))}d ago`;
  if (ageMin < 30) return { tone: "good", label };
  if (ageMin < 120) return { tone: "warn", label };
  return { tone: "bad", label };
}

/** The flow scoreboard — is the loop CYCLING (in vs out), not just how big the pile is. */
function FlowStrip({ flow }: { flow: ImprovementFlow }) {
  const net = flow.net7d;
  const netTone: "good" | "warn" | "flat" =
    net < 0 ? "good" : net > 0 ? "warn" : "flat";
  const wd = watchdogHealth(flow.watchdog.lastTickAt, Date.now());
  return (
    <div
      className="pc-learning__flow"
      aria-label="Improvement flow (trailing window)"
    >
      <span
        className="pc-learning__flowchip"
        title="Items captured vs resolved in the trailing 7 days — the loop's in-flow vs out-flow. A shrinking backlog (↓) means resolution is keeping up with capture."
      >
        <Activity size={11} aria-hidden />
        <strong>{flow.captured7d}</strong> in /{" "}
        <strong>{flow.resolved7d}</strong> out
        <em>7d</em>
        <span
          className={`pc-learning__flownet pc-learning__flownet--${netTone}`}
          title="Net backlog change over 7 days (captured − resolved)"
        >
          {net > 0 ? (
            <ArrowUp size={10} aria-hidden />
          ) : net < 0 ? (
            <ArrowDown size={10} aria-hidden />
          ) : (
            <Minus size={10} aria-hidden />
          )}
          {net > 0 ? `+${net}` : net}
        </span>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Median age of the open items — fresh churn or sediment? Rising median = the backlog is silting up."
      >
        <Hourglass size={11} aria-hidden />
        median open{" "}
        <strong>
          {flow.medianOpenAgeDays == null
            ? "—"
            : ageLabel(flow.medianOpenAgeDays)}
        </strong>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Friction signatures captured more than once — the same problem coming back. Recurrence is the strongest 'fix this next' signal."
      >
        <Repeat2 size={11} aria-hidden />
        <strong>{flow.recurringSignatureCount}</strong> recurring
      </span>
      <span
        className={`pc-learning__flowchip pc-learning__flowchip--wd-${wd.tone}`}
        title={`The watchdog auto-files objective problems on a cadence — if it stops ticking, the capture feed has silently died. ${flow.watchdog.ticks24h} tick(s) and ${flow.watchdog.captured24h} capture(s) in the last 24h.`}
      >
        <span
          className={`pc-learning__flowdot pc-learning__flowdot--${wd.tone}`}
          aria-hidden
        />
        watchdog <strong>{wd.label}</strong>
        <em>
          {flow.watchdog.ticks24h} ticks / {flow.watchdog.captured24h} captured
          · 24h
        </em>
      </span>
      {flow.dispatch ? <DispatchChip d={flow.dispatch} /> : null}
    </div>
  );
}

/**
 * Auto-implement dispatch ledger chip (consume-edges P-010 / B-04) — the BACK
 * edge's vitals: fired vs actually fixed, workers in progress vs presumed dead.
 * Red when anything is dying silently (overdue / fire-failed / orphaned), green
 * when the lane is genuinely fixing things.
 */
function DispatchChip({ d }: { d: NonNullable<ImprovementFlow["dispatch"]> }) {
  const dead = d.overdue + d.fireFailed + d.orphaned;
  const tone: "good" | "warn" | "bad" =
    dead > 0 ? "bad" : d.fixed7d > 0 ? "good" : "warn";
  return (
    <span
      className={`pc-learning__flowchip pc-learning__flowchip--wd-${tone}`}
      title={
        `Auto-implement dispatch ledger: ${d.fired7d} dispatch(es) fired in 7d, ${d.resolved.fixed} fixed / ` +
        `${d.resolved.couldNotFix} could-not-fix / ${d.resolved.needsHuman} needs-human all-time; ` +
        `${d.inProgress + d.firing} in progress, ${d.overdue} overdue (worker presumed dead), ` +
        `${d.fireFailed} fire-failed, ${d.orphaned} orphaned. A dispatch that never reaches a terminal state is the EI-365 black hole this ledger exists to expose.`
      }
    >
      <Send size={11} aria-hidden />
      dispatch <strong>{d.fired7d}</strong> fired / <strong>{d.fixed7d}</strong>{" "}
      fixed
      <em>7d</em>
      {dead > 0 ? (
        <strong>{dead} dead</strong>
      ) : (
        <em>{d.inProgress + d.firing} live</em>
      )}
    </span>
  );
}

// ─── Gym view ────────────────────────────────────────────────────────────────

interface GymProposal {
  id: string;
  harnessSlug: string;
  cycle: number;
  role: string;
  variantId?: string | null;
  rationale: string | null;
  devAnchorDelta: number | null;
  costDelta: number | null;
  probeStatus?: string | null;
  proposedMd?: string | null;
  status: string; // pending | accepted | rejected | superseded
  createdAt: number;
  decidedAt: number | null;
}
interface GymAutoloop {
  harnessSlug: string;
  enabled: boolean;
  status: string; // idle | running | paused | exhausted
  budgetUsd: number | null;
  spentUsd: number;
  lastCycle: number | null;
}
interface GymArchiveSeed {
  candidateId: string;
  nicheKey: string;
  fitness: number;
  rationale: string | null;
  updatedAt: number;
  harnessSlug: string;
}
/** WI-5685: one completed gym cycle from the durable run-analytics — the record
 *  of a RUN having happened, independent of whether it minted a proposal (a
 *  losing candidate mints none, which used to make the whole run invisible). */
interface GymRecentCycle {
  /** WI-5799: run-scoped identity; `cycle` alone repeats across runs. */
  cycleId?: string;
  harnessSlug: string;
  cycle: number;
  parentId: string | null;
  candidateId: string | null;
  decision: string | null; // 'accept' | 'reject' | null
  runCount: number;
  startedAt: number | null;
  finishedAt: number | null;
}
/** WI-5808: one variant's runs within a cycle, straight from gym_runs. */
interface GymRecentRun {
  harnessSlug: string;
  variantId: string;
  cycle: number;
  runCount: number;
  states: string[];
  startedAt: number | null;
  finishedAt: number | null;
  decision: string | null;
  isBaseline: boolean;
}
interface GymSnapshot {
  proposals: GymProposal[];
  autoloops: GymAutoloop[];
  /** Scout-seeded MAP-Elites niches (WI-5412 item 4) — absent on older server snapshots. */
  archiveSeeds?: GymArchiveSeed[];
  /** Recent completed cycles (WI-5685) — absent on older server snapshots. */
  cycles?: GymRecentCycle[];
  /** WI-5808: recent RUN activity from gym_runs — the table that accumulates. */
  runs?: GymRecentRun[];
  /** ISO timestamp this snapshot was generated server-side. */
  generatedAt?: string;
  /**
   * WI-5420: true when the requested Hive's own gym-scoped read came back
   * empty and the server fell back to the workspace-wide rollup below (real
   * data recorded under a harness not scoped to this Hive — e.g. a manual
   * `gym-loop-run.ts` run — would otherwise render as "No gym experiments").
   * Absent/false ⇒ the data below is genuinely scoped to the requested Hive.
   */
  scopeFallback?: boolean;
}

/** Stable category color per creative lens (owner ask 2026-07-19d): the deck
 *  accent follows the CATEGORY, never the stack order. Hash into the theme's
 *  fixed categorical swatches so a lens keeps its hue across views/renders
 *  (same scheme SignalsPanel uses for lanes). */
const CATEGORICAL_HEXES = Object.values(CATEGORICAL).map((c) => c.hex);
function lensColor(lens: string): string {
  let h = 0;
  for (let i = 0; i < lens.length; i++) h = (h * 31 + lens.charCodeAt(i)) | 0;
  return CATEGORICAL_HEXES[Math.abs(h) % CATEGORICAL_HEXES.length];
}

function whenLabel(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function deltaLabel(d: number | null): {
  text: string;
  tone: "good" | "bad" | "flat";
} {
  if (d === null || d === undefined || Number.isNaN(d))
    return { text: "—", tone: "flat" };
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  return {
    text: `${sign}${Math.abs(d).toFixed(3)}`,
    tone: d > 0 ? "good" : d < 0 ? "bad" : "flat",
  };
}

function GymView({
  hive,
  hiveReady,
  onStatus,
  active = true,
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const openArming = useOpenArming();
  // Collapsed challenger role groups — comma-separated roles, in the URL so the
  // view is shareable and agent-readable (repo convention: user-meaningful state
  // goes in nuqs, never useState).
  const [collapsedRolesRaw, setCollapsedRoles] = useQueryState("gymroles", parseAsString);
  const collapsedRoles = useMemo(
    () => new Set((collapsedRolesRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    [collapsedRolesRaw],
  );
  const toggleRole = (role: string) => {
    const next = new Set(collapsedRoles);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    void setCollapsedRoles(next.size ? [...next].sort().join(",") : null);
  };
  // P-042: scope the gym rollup to one hive's gym harness; '' ⇒ the whole
  // workspace (every gym harness). Gated on hiveReady (WI-5412) so the first
  // click never pays a wrong-lens fetch + refetch.
  const sync = useSyncQuery<GymSnapshot>({
    queryName: "learning.gym",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  // WI-5809 (owner report 2026-07-25): the client-side cross-tenant fallback is
  // GONE, matching the server. It used to refetch the workspace-wide rollup when
  // the selected pot's own read was empty — which is how selecting Oddsmith
  // rendered PAPERCUSP's gym experiments. A selected pot now shows only its own
  // data, or an honest empty state naming the pot.
  const snap = sync.data?.[0];
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points (pipeline /
  // observations / improvements / learnings): gated on the PRIMARY read
  // only, settles on a fault as well as success, gated on `active` so a
  // warm-but-inactive pane doesn't emit on a revisit that never remounts
  // (EI-19383745196363732).
  const gymSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(PERF_INTERACTIONS.learningViewSwitch, gymSettled, active);
  const proposals = snap?.proposals ?? [];
  const autoloops = snap?.autoloops ?? [];
  const archiveSeeds = snap?.archiveSeeds ?? [];
  const cycles = snap?.cycles ?? [];
  // WI-5808: RUN activity, read from gym_runs — the table that actually
  // accumulates. This is what answers "is the gym doing anything lately";
  // `cycles` only gains a row when a cycle COMPLETES.
  const runs = snap?.runs ?? [];
  const activeAutoloops = autoloops.filter(
    (autoloop) => autoloop.enabled || autoloop.status === "running",
  );

  const champions = proposals.filter((p) => p.status === "accepted").length;
  const pending = proposals.filter((p) => p.status === "pending").length;
  const rejected = proposals.filter((p) => p.status === "rejected").length;
  // Newest run instant across the listed groups — stamped into the sticky
  // "Recent challengers" header so recency is legible at any scroll position.
  const newestRunAtMs = useMemo<number | null>(() => {
    let newest: number | null = null;
    for (const r of runs) {
      const when = r.finishedAt ?? r.startedAt;
      if (when != null && (newest == null || when > newest)) newest = when;
    }
    return newest;
  }, [runs]);

  /**
   * ONE card per challenger (owner ask 2026-07-27: "why isn't RECENT CHALLENGERS
   * just cards like the other section?").
   *
   * The two blocks were the SAME events rendered twice: a compact line per
   * gym_runs group (execution: when, run count, terminal states, decision) and a
   * card per gym_proposals row (proposal: prompt, benchmark delta, cost, probes,
   * judge rationale) — measured 17 run groups vs 17 proposals with 15 overlapping.
   * WI-5696 added the lines only so a cycle that minted NO proposal stayed
   * visible, and promised they would "vanish via the dedupe" once every decision
   * minted one (WI-5697); the dedupe was never written, so both rendered and the
   * duplicate block pushed the cards out of the pane.
   *
   * Merge instead of choosing: each proposal card carries its own execution facts,
   * so nothing the lines conveyed is lost, and the compact line survives ONLY for
   * its designed exception (see `orphanRuns`).
   */
  const runByVariant = useMemo(() => {
    const at = (r: GymRecentRun) => r.finishedAt ?? r.startedAt ?? 0;
    const m = new Map<string, GymRecentRun>();
    for (const r of runs) {
      const prior = m.get(r.variantId);
      if (!prior || at(r) > at(prior)) m.set(r.variantId, r);
    }
    return m;
  }, [runs]);

  /** Challengers newest-first, each paired with the run group that executed it. */
  const challengerCards = useMemo(
    () =>
      proposals
        .map((p) => ({ p, run: p.variantId ? runByVariant.get(p.variantId) ?? null : null }))
        .sort((a, b) => (b.p.createdAt ?? 0) - (a.p.createdAt ?? 0)),
    [proposals, runByVariant],
  );

  /**
   * Executions with NO proposal card — the champion baseline (mints none by
   * design) and any cycle that minted nothing. This is the only case the compact
   * line was ever for, so it is the only case that still renders one.
   */
  const orphanRuns = useMemo(() => {
    const carded = new Set(proposals.map((p) => p.variantId).filter(Boolean) as string[]);
    return runs.filter((r) => !carded.has(r.variantId));
  }, [runs, proposals]);

  /**
   * Cards stay GROUPED BY ROLE (owner ask 2026-07-27: "why are the new cards not
   * collapsed by type like previously") — the flat grid lost the per-role stacks
   * the CardStack decks gave. Group ordering is by RECENCY of the group's newest
   * challenger, not by size, so the role the gym is actually working on leads;
   * within a group cards stay newest-first. Each group collapses (state in nuqs
   * per repo convention, so it is shareable + agent-visible).
   */
  const challengerGroups = useMemo(() => {
    const byRole = new Map<string, typeof challengerCards>();
    for (const entry of challengerCards) {
      const role = entry.p.role || "unknown";
      const bucket = byRole.get(role);
      if (bucket) bucket.push(entry);
      else byRole.set(role, [entry]);
    }
    return [...byRole.entries()]
      .map(([role, items]) => ({
        role,
        items,
        accent: lensColor(role),
        newestAt: items.reduce<number | null>((acc, { p, run }) => {
          const when = p.createdAt ?? run?.finishedAt ?? null;
          return when != null && (acc == null || when > acc) ? when : acc;
        }, null),
      }))
      .sort((a, b) => (b.newestAt ?? 0) - (a.newestAt ?? 0) || a.role.localeCompare(b.role));
  }, [challengerCards]);
  const t = useLexicon();
  const running = activeAutoloops.length;
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : !snap
          ? "neutral"
          : pending > 0
            ? "warn"
            : running > 0 || champions > 0
              ? "good"
              : "neutral",
    );
  }, [champions, onStatus, pending, running, snap, sync.error]);

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Dumbbell}
        title="Prompt gym"
        generatedAt={snap?.generatedAt}
        signal={running > 0 ? `${running} active` : undefined}
        tone={running > 0 ? "good" : "neutral"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the gym feed"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {/* How things reach the gym — the succinct two-path explanation, in the
          header-desc idiom (owner ask 2026-07-19); the fuller mechanics ride
          the tooltip. */}
      <p
        className="pc-learning__sectionsub pc-learning__gymhow"
        title={`Path 1 — ${t("scout")} routing: every fused idea carries a routeHint from the recombine step; small, cheaply testable (prompt-shaped) ideas route to the gym rail as challenger candidates + QD-archive niche seeds. Unhinted ideas default to the improvement rail; plans/benchmarks have their own rails. Path 2 — the autoloop: a per-${t("pot", { lower: true })} config (enabled + an explicit budget cap — no cap, no unattended runs); a 30-min routine round-robins enabled ${t("pot", { plural: true, lower: true })} and runs one budget-bounded challenger-vs-champion cycle, accumulating spend until the budget floor stops it. Winning challengers (positive benchmark delta) auto-promote to champion at end of run — owner mandate 2026-07-19; losers auto-reject; every decision stays in the ledger.`}
      >
        Two ways in: {t("scout")} routes small, cheaply testable ideas here
        (challengers + archive niche seeds), and each enabled, budgeted{" "}
        {t("pot", { lower: true })} autoloop runs challenger-vs-champion cycles
        (~every 30 min) until its budget is spent. Fully autonomous: a
        challenger that beats the champion on the benchmark is promoted
        automatically — the ledger below is the audit trail.
      </p>

      {snap && proposals.length >= 4 ? (
        // The header signal already carries "N active" (running loops); this line
        // is the experiment breakdown, Champions the one accent when there are any.
        <LearningStatLine
          stats={[
            {
              label: "Champions",
              value: champions,
              tone: champions > 0 ? "good" : undefined,
            },
            { label: "Tested", value: proposals.length },
            {
              label: "Pending",
              value: pending,
              tone: pending > 0 ? "warn" : undefined,
            },
            { label: "Rejected", value: rejected },
          ]}
        />
      ) : null}

      {activeAutoloops.length > 0 && (
        <div className="pc-learning__loops" aria-label="Gym autoloops">
          {activeAutoloops.map((a) => (
            <span
              key={a.harnessSlug}
              className={`pc-learning__loop pc-learning__loop--${a.status}`}
              title={`This gym runs experiment cycles on its own${a.budgetUsd != null ? ` — $${a.spentUsd.toFixed(2)} spent of a $${a.budgetUsd.toFixed(0)} budget` : ""}`}
            >
              <Dumbbell size={11} aria-hidden />
              {a.harnessSlug}
              <em>{a.enabled ? a.status : "off"}</em>
              {a.budgetUsd != null && (
                <span className="pc-learning__loopspend">
                  ${a.spentUsd.toFixed(2)}/${a.budgetUsd.toFixed(0)}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* The empty state must require a RESOLVED-empty snapshot — never a
          not-yet-fetched one. Until the gym query has actually returned (`snap`
          defined), we are loading, NOT empty. Before this, a false `hiveReady`
          gate (or any pre-first-result gap) rendered undefined `snap` as "No gym
          experiments" even though the workspace had proposals (owner report
          2026-07-19; the server returns them correctly — verified end-to-end). */}
      {!snap && !sync.error ? (
        <p className="pc-learning__empty">Loading gym experiments…</p>
      ) : sync.error ? (
        <LearningVisualError
          title="Gym unavailable"
          onRetry={() => sync.invalidate()}
        />
      ) : proposals.length === 0 &&
        archiveSeeds.length === 0 &&
        cycles.length === 0 &&
        runs.length === 0 ? (
        <LearningVisualEmpty
          icon={Dumbbell}
          title={
            hive
              ? `No gym activity for ${hive} yet`
              : "No gym activity in this workspace yet"
          }
          body={`Armed ${t("pot", { plural: true, lower: true })} A/B-refine their blueprints under a budget you set — completed cycles land here with their verdicts.`}
          action={{ label: "Arm the Gym", onClick: openArming }}
        />
      ) : (
        <>
          {proposals.length > 0 || runs.length > 0 ? (
            <>
              {/* STICKY + carries RECENCY (owner escalation 2026-07-26, ~20
                  reports of "no recent gym runs"): the runs list is newest-first
                  at the TOP of this scrolling pane, and the judge cards the user
                  actually reads are BELOW it — so reading a card necessarily
                  scrolls every recent run out of view. With a ~268px fixed header
                  (stage strip + tabs + subtitle + the orientation banner) the
                  scroll area is only ~800px, so a ~250px scroll already hides the
                  6 newest rows and leaves e.g. "9h ago" as the topmost visible
                  line — which reads as "the gym has produced nothing recent"
                  (REPRODUCED live at scrollTop 250). Pinning this header and
                  stamping the newest run's age into it means the answer to "is
                  anything recent?" is on screen at EVERY scroll position. */}
              <div className="pc-learning__sectionhead pc-learning__sectionhead--stickyruns">
                <h2>Recent challengers</h2>
                {newestRunAtMs != null ? (
                  <span
                    className="pc-learning__runsrecency"
                    title={`Newest gym run finished ${new Date(newestRunAtMs).toLocaleString()}. ${runs.length} run group(s) listed, newest first — scroll up for the newest.`}
                  >
                    newest {whenLabel(newestRunAtMs)}
                    {runs.length > 0 ? ` · ${runs.length} listed` : ""}
                  </span>
                ) : null}
              </div>
              {/* WI-5696's dedupe, finally implemented (owner ask 2026-07-27):
                  a compact line renders ONLY for an execution with no proposal
                  card — the champion baseline, or a cycle that minted nothing.
                  Every other challenger is a card below, carrying these same
                  execution facts, so this block no longer duplicates the cards
                  (it was 15 of 17 duplicates) or pushes them out of the pane. */}
              {orphanRuns.length > 0 ? (
                <div className="pc-learning__gymcycles" aria-label="Gym runs without a proposal">
                  {orphanRuns.map((r) => {
                    const promoted = r.decision === "accept" || r.decision === "promote";
                    const tone = r.isBaseline
                      ? "pending"
                      : promoted
                        ? "accepted"
                        : r.decision
                          ? "rejected"
                          : "pending";
                    const decisionColor = statusToneColor(tone);
                    const when = r.finishedAt ?? r.startedAt;
                    return (
                      <div
                        key={`${r.harnessSlug}:${r.variantId}:${r.cycle}`}
                        className="pc-learning__muted"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                          fontSize: 12,
                          padding: "2px 0",
                        }}
                        title={`${r.runCount} scored run(s) of ${r.variantId} in cycle ${r.cycle} on ${r.harnessSlug}${r.states.length ? ` — outcomes: ${r.states.join(", ")}` : ""}${when ? ` — ${new Date(when).toLocaleString()}` : ""}`}
                      >
                        {when ? (
                          <span className="pc-learning__age">{whenLabel(when)}</span>
                        ) : null}
                        <span
                          className="pc-learning__chip"
                          style={{ color: decisionColor, borderColor: decisionColor }}
                        >
                          {r.isBaseline ? (
                            <Clock size={10} aria-hidden />
                          ) : promoted ? (
                            <CheckCircle2 size={10} aria-hidden />
                          ) : r.decision ? (
                            <XCircle size={10} aria-hidden />
                          ) : (
                            <Clock size={10} aria-hidden />
                          )}
                          {r.isBaseline
                            ? "champion baseline"
                            : promoted
                              ? "promoted"
                              : r.decision
                                ? "champion held"
                                : "evaluated"}
                        </span>
                        <span>
                          {r.variantId} · cycle {r.cycle} · {r.runCount} run
                          {r.runCount === 1 ? "" : "s"} · {r.harnessSlug}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
          {proposals.length > 0 ? (
            <>
              {/* A GRID of challenger cards, newest first — not a per-role
                  1-of-N carousel (owner ask 2026-07-27). The carousel showed one
                  card at a time, which is why the compact duplicate lines were
                  silently doing overview duty; a grid is the overview AND the
                  detail, so both jobs are done once. Role moves onto the card as
                  a chip + accent, so the per-role grouping information survives. */}
              {challengerGroups.map((group) => {
                const collapsed = collapsedRoles.has(group.role);
                return (
                  <section
                    key={group.role}
                    className="pc-learning__gymrolegroup"
                    aria-label={`${group.role} challengers`}
                  >
                    <button
                      type="button"
                      className="pc-learning__gymrolehead"
                      style={{ borderLeftColor: group.accent }}
                      onClick={() => toggleRole(group.role)}
                      aria-expanded={!collapsed}
                    >
                      {collapsed ? (
                        <ChevronRight size={12} aria-hidden />
                      ) : (
                        <ChevronDown size={12} aria-hidden />
                      )}
                      <span
                        className="pc-learning__gymrolename"
                        style={{ color: group.accent }}
                      >
                        {group.role}
                      </span>
                      <span className="pc-learning__chip">{group.items.length}</span>
                      {group.newestAt != null ? (
                        <span className="pc-learning__age">
                          newest {whenLabel(group.newestAt)}
                        </span>
                      ) : null}
                    </button>
                    {collapsed ? null : (
              <div className="pc-learning__gymcardgrid">
                {group.items.map(({ p, run }) => {
                  const role = p.role || "unknown";
                  const accent = lensColor(role);
                  const delta = deltaLabel(p.devAnchorDelta);
                  const statusColor = statusToneColor(p.status);
                  return (
                    <section
                      key={p.id}
                      className="pc-learning__gymcard"
                      style={{ borderLeftColor: accent }}
                      aria-label={`${role} challenger ${p.variantId ?? p.id}`}
                    >
                      <div className="pc-learning__ideacard">
                              <div className="pc-learning__ideacard-head">
                                <span
                                  className="pc-learning__chip"
                                  style={{ color: statusColor, borderColor: statusColor }}
                                >
                                  {p.status === "accepted" ? (
                                    <CheckCircle2 size={10} aria-hidden />
                                  ) : p.status === "rejected" ? (
                                    <XCircle size={10} aria-hidden />
                                  ) : (
                                    <Clock size={10} aria-hidden />
                                  )}
                                  {p.status === "accepted" ? "champion" : p.status}
                                </span>
                                <span
                                  className="pc-learning__chip"
                                  style={{ color: accent, borderColor: accent }}
                                  title="The agent role whose prompt this challenger rewrites"
                                >
                                  {role}
                                </span>
                                <span className="pc-learning__chip" title="Gym cycle number">
                                  cycle {p.cycle}
                                </span>
                                {/* The execution facts the compact line used to
                                    carry — folded in so removing the duplicate
                                    line loses nothing. */}
                                {run ? (
                                  <span
                                    className="pc-learning__chip"
                                    title={`${run.runCount} scored run(s) of ${run.variantId}${run.states.length ? ` — outcomes: ${run.states.join(", ")}` : ""}`}
                                  >
                                    {run.runCount} run{run.runCount === 1 ? "" : "s"}
                                    {run.states.length ? ` · ${run.states.join(", ")}` : ""}
                                  </span>
                                ) : null}
                                <span className="pc-learning__age">
                                  {whenLabel(p.createdAt)}
                                  {p.decidedAt
                                    ? ` · decided ${whenLabel(p.decidedAt)}`
                                    : ""}
                                </span>
                              </div>
                              <strong className="pc-learning__gymtitle">
                                {p.rationale ?? p.variantId ?? p.id}
                              </strong>
                              <div className="pc-learning__gymdeltas">
                                <span
                                  className={`pc-learning__delta pc-learning__delta--${delta.tone}`}
                                  title="Judge-score change vs the current champion — positive means the challenger did better"
                                >
                                  {delta.text} benchmark
                                </span>
                                {p.costDelta != null ? (
                                  <span
                                    className={`pc-learning__delta pc-learning__delta--${p.costDelta > 0 ? "bad" : p.costDelta < 0 ? "good" : "flat"}`}
                                    title="Per-task cost change vs the champion"
                                  >
                                    {p.costDelta > 0 ? "+" : ""}
                                    {p.costDelta.toFixed(2)} cost
                                  </span>
                                ) : null}
                                {p.probeStatus ? (
                                  <span
                                    className="pc-learning__chip"
                                    title="Regression-probe verdict — did the challenger still catch the planted failures?"
                                  >
                                    probes: {p.probeStatus}
                                  </span>
                                ) : null}
                                <span
                                  className="pc-learning__chip pc-learning__chip--idea"
                                  title="The gym harness that ran this experiment"
                                >
                                  {p.harnessSlug}
                                </span>
                              </div>
                              {p.proposedMd ? (
                                <pre
                                  className="pc-learning__gymprompt"
                                  title="The challenger prompt (first lines)"
                                >
                                  {p.proposedMd}
                                </pre>
                              ) : null}
                            </div>
                    </section>
                  );
                })}
              </div>
                    )}
                  </section>
                );
              })}
            </>
          ) : null}
          {/* WI-5412 item 4: the gym-rail pills in Ideas reference Scout-SEEDED
              archive niches (`gym:SP-…`), a different dataset from the
              prompt-optimization challengers above — this section is where
              those pills actually land. A seed absent here was superseded by a
              stronger candidate (its niche shows the winner). */}
          {archiveSeeds.length > 0 ? (
            <>
              <div className="pc-learning__sectionhead">
                <h2>Archive seeds</h2>
                <span
                  className="pc-learning__muted"
                  title="Scout-routed testable ideas are inserted straight into the MAP-Elites quality-diversity archive as niche seeds — they open unexplored idea territory rather than challenging a live prompt."
                >
                  Scout-seeded quality-diversity niches
                </span>
              </div>
              <div className="pc-learning__lensstacks">
                <section
                  className="pc-learning__lensgroup"
                  aria-label="Archive niche seeds"
                >
                  <CardStack
                    items={archiveSeeds}
                    getKey={(seed) => `${seed.harnessSlug}:${seed.nicheKey}`}
                    ariaLabel="Archive niche seeds"
                    accent={lensColor("niche seeds")}
                    header={
                      <>
                        <span className="pc-cardstack__header-label">
                          niche seeds
                        </span>
                        <span className="pc-cardstack__header-count">
                          {archiveSeeds.length}
                        </span>
                      </>
                    }
                    renderCard={(seed) => (
                      <div className="pc-learning__ideacard">
                        <div className="pc-learning__ideacard-head">
                          <span
                            className="pc-learning__chip pc-learning__chip--idea"
                            title="The MAP-Elites niche this seed holds (scope | domain | risk)"
                          >
                            {seed.nicheKey}
                          </span>
                          <span
                            className="pc-learning__chip"
                            title="The seed's fitness score in its niche"
                          >
                            fitness {seed.fitness.toFixed(2)}
                          </span>
                          <span className="pc-learning__age">
                            {whenLabel(seed.updatedAt)}
                          </span>
                        </div>
                        <strong className="pc-learning__gymtitle">
                          {seed.rationale ?? seed.candidateId}
                        </strong>
                        <div className="pc-learning__gymdeltas">
                          <span
                            className="pc-learning__chip"
                            title="The seeded candidate id"
                          >
                            {seed.candidateId}
                          </span>
                          <span
                            className="pc-learning__chip pc-learning__chip--idea"
                            title="The gym harness whose archive holds this niche"
                          >
                            {seed.harnessSlug}
                          </span>
                        </div>
                      </div>
                    )}
                  />
                </section>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Benchmark view (apiary / IQ-battery) ────────────────────────────────────

interface ApiaryInstance {
  instanceId: string;
  codeSha: string;
  createdAt: string;
  totalRuns: number;
  successfulRuns: number;
  successRate: number;
  meanComposite: number | null;
  meanTimeToGreenSecs: number | null;
  meanTokens: number | null;
  escalationRate: number | null;
  firstAttemptRate: number | null;
}

const pctLabel = (v: number | null): string =>
  v == null ? "—" : `${Math.round(v * 100)}%`;
const compositeLabel = (v: number | null): string =>
  v == null ? "—" : v.toFixed(3);
function secsLabel(v: number | null): string {
  if (v == null) return "—";
  return v < 90 ? `${Math.round(v)}s` : `${(v / 60).toFixed(1)}m`;
}
function tokensLabel(v: number | null): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}
const shortSha = (s: string): string => (s ? s.slice(0, 7) : "—");
function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ApiaryView({
  onStatus,
  active = true,
}: {
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const sync = useSyncQuery<{ instances: ApiaryInstance[] }>({
    queryName: "learning.apiary",
    args: {},
    staleTime: 30_000,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that
  // never remounts (EI-19383745196363732).
  const apiarySettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    apiarySettled,
    active,
  );
  const instances = sync.data?.[0]?.instances ?? [];
  // WI-6410: `sync.error` below covered the TRANSPORT half only. The resolver
  // catches its own failure and resolves with a degraded payload, so the error
  // branch was unreachable for exactly the failure mode most likely to happen.
  const fault = snapshotFault(sync.error, sync.data?.[0], "Benchmark");
  const newest = instances[0];
  const scored = instances.filter((instance) => instance.meanComposite != null);
  const latest = scored[0];
  const previous = scored[1];
  const pending = newest && newest.meanComposite == null ? newest : null;
  const currentDelta =
    latest?.meanComposite != null && previous?.meanComposite != null
      ? latest.meanComposite - previous.meanComposite
      : null;
  const currentDeltaMeta = deltaLabel(currentDelta);
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : pending
          ? "good"
          : latest && latest.successRate >= 0.8
            ? "good"
            : "neutral",
    );
  }, [latest, onStatus, pending, sync.error]);
  const renderInstance = (inst: ApiaryInstance, i: number) => {
    const prev = instances[i + 1];
    const dComposite =
      inst.meanComposite != null && prev?.meanComposite != null
        ? inst.meanComposite - prev.meanComposite
        : null;
    const delta = deltaLabel(dComposite);
    return (
      <li
        key={inst.instanceId}
        className="pc-learning__row pc-learning__row--bench"
        title={inst.instanceId}
      >
        <span
          className="pc-learning__sev"
          style={{ background: delta.tone === "bad" ? "#fb7185" : "#34d399" }}
          aria-hidden
        />
        <span className="pc-learning__id" title={inst.codeSha}>
          {shortSha(inst.codeSha)}
        </span>
        <span className="pc-learning__benchcell">
          <span className="pc-learning__benchnum">
            {compositeLabel(inst.meanComposite)}
          </span>
          {i < instances.length - 1 ? (
            <span
              className={`pc-learning__delta pc-learning__delta--${delta.tone}`}
            >
              Δ {delta.text}
            </span>
          ) : null}
          <span className="pc-learning__benchmeta">
            {inst.successfulRuns}/{inst.totalRuns} solved
          </span>
        </span>
        <span className="pc-learning__meta">
          <span className="pc-learning__age">
            {secsLabel(inst.meanTimeToGreenSecs)}
          </span>
          <span className="pc-learning__age">
            {tokensLabel(inst.meanTokens)}
          </span>
          <span className="pc-learning__age">{dateLabel(inst.createdAt)}</span>
        </span>
      </li>
    );
  };

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Gauge}
        title="Benchmark"
        question="Did the new build get better?"
        signal={
          latest
            ? `${latest.successfulRuns}/${latest.totalRuns} solved`
            : undefined
        }
        tone={latest && latest.successRate >= 0.8 ? "good" : "neutral"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the benchmark"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {sync.loading && !sync.data ? (
        <p className="pc-learning__empty">Loading the benchmark…</p>
      ) : fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Benchmark unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : !latest && !pending ? (
        // WI-6388: teaching copy per LearningVisualEmpty's own contract.
              <LearningVisualEmpty
                icon={Gauge}
                title="No benchmark runs"
                body="This view compares runs against the same benchmark set, so a regression shows up as a score drop. Runs appear here once a benchmark has been run."
              />
      ) : (
        <>
          {!latest && pending ? (
            <div className="pc-learning-visual__layout">
              <LearningHeroMetric
                eyebrow={shortSha(pending.codeSha)}
                value={`${pending.successfulRuns}/${pending.totalRuns}`}
                status="pending"
                tone="accent"
              >
                runs complete
              </LearningHeroMetric>
            </div>
          ) : null}
          {latest ? (
            <>
              <div className="pc-learning-visual__layout">
                <LearningHeroMetric
                  eyebrow={shortSha(latest.codeSha)}
                  value={compositeLabel(latest.meanComposite)}
                  status={
                    currentDelta == null
                      ? "baseline"
                      : currentDelta > 0
                        ? "improved"
                        : currentDelta < 0
                          ? "regressed"
                          : "unchanged"
                  }
                  tone={
                    currentDelta == null
                      ? "accent"
                      : currentDelta > 0
                        ? "good"
                        : currentDelta < 0
                          ? "bad"
                          : "neutral"
                  }
                >
                  <span>
                    {currentDelta != null
                      ? `Δ ${currentDeltaMeta.text}`
                      : "first generation"}
                  </span>
                  {pending ? (
                    <span
                      className="pc-learning__pendinginline"
                      role="status"
                      title={`${shortSha(pending.codeSha)} is awaiting a scored result`}
                    >
                      <Clock size={10} aria-hidden />
                      {shortSha(pending.codeSha)} · {pending.successfulRuns}/
                      {pending.totalRuns}
                    </span>
                  ) : null}
                </LearningHeroMetric>
                <LearningComparisonBars
                  title="Previous vs current"
                  baselineName="Previous"
                  treatmentName="Current"
                  rows={[
                    {
                      label: "Composite",
                      baseline: previous?.meanComposite ?? null,
                      treatment: latest.meanComposite,
                      baselineLabel: compositeLabel(
                        previous?.meanComposite ?? null,
                      ),
                      treatmentLabel: compositeLabel(latest.meanComposite),
                      max: 10,
                      treatmentWins:
                        latest.meanComposite != null &&
                        latest.meanComposite >=
                          (previous?.meanComposite ?? -Infinity),
                    },
                    {
                      label: "Success",
                      baseline: previous?.successRate ?? null,
                      treatment: latest.successRate,
                      baselineLabel: pctLabel(previous?.successRate ?? null),
                      treatmentLabel: pctLabel(latest.successRate),
                      max: 1,
                      treatmentWins:
                        latest.successRate >=
                        (previous?.successRate ?? -Infinity),
                    },
                    {
                      label: "Time to green",
                      baseline: previous?.meanTimeToGreenSecs ?? null,
                      treatment: latest.meanTimeToGreenSecs,
                      baselineLabel: secsLabel(
                        previous?.meanTimeToGreenSecs ?? null,
                      ),
                      treatmentLabel: secsLabel(latest.meanTimeToGreenSecs),
                      treatmentWins:
                        latest.meanTimeToGreenSecs != null &&
                        latest.meanTimeToGreenSecs <=
                          (previous?.meanTimeToGreenSecs ?? Infinity),
                    },
                  ]}
                />
                <LearningEvidenceRail>
                  <div className="pc-learning-visual__evidence-grid">
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Success</span>
                      <strong>{pctLabel(latest.successRate)}</strong>
                    </div>
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Time</span>
                      <strong>{secsLabel(latest.meanTimeToGreenSecs)}</strong>
                    </div>
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Tokens</span>
                      <strong>{tokensLabel(latest.meanTokens)}</strong>
                    </div>
                    <div className="pc-learning-visual__evidence-metric">
                      <span>Escalations</span>
                      <strong>{pctLabel(latest.escalationRate)}</strong>
                    </div>
                  </div>
                </LearningEvidenceRail>
              </div>
            </>
          ) : null}

          <BenchmarkTrend instances={instances} />

          <div className="pc-learning__sectionhead">
            <h2>Recent generations</h2>
          </div>
          <ul className="pc-learning__list">
            {instances.slice(0, 5).map(renderInstance)}
          </ul>
          {instances.length > 5 ? (
            <LearningDisclosure
              label="Earlier generations"
              count={instances.length - 5}
            >
              <ul className="pc-learning__list">
                {instances
                  .slice(5)
                  .map((inst, i) => renderInstance(inst, i + 5))}
              </ul>
            </LearningDisclosure>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Hive orchestration trend (hive-eval battery — hive-run-evaluation HE-07) ──
//
// The SIBLING of the apiary trend: where the apiary scores how good the agents' CODE gets over
// generations, this scores how good the Hive's ORCHESTRATION gets (outcome quality · efficiency ·
// speed, gated un-gameably). Its own `learning.hiveEvalTrend` snapshot over the hive_eval tables;
// reuses the BenchmarkTrend surface. Owner-gated (P-051) — graceful-empty until the first armed run.

interface HiveEvalGeneration {
  instanceId: string;
  codeSha: string;
  createdAt: string;
  totalRuns: number;
  scoredRuns: number;
  meanComposite: number | null;
  meanEfficiency: number | null;
  meanSpeed: number | null;
  meanCriticalPathRatio: number | null;
  outcomeGatePassRate: number | null;
  fabricationRate: number | null;
}

const ratioLabel = (v: number | null): string =>
  v == null ? "—" : `${v.toFixed(2)}×`;

function HiveEvalTrendView({
  onStatus,
  active = true,
}: {
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const sync = useSyncQuery<{ instances: HiveEvalGeneration[] }>({
    queryName: "learning.hiveEvalTrend",
    args: {},
    staleTime: 30_000,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that
  // never remounts (EI-19383745196363732).
  const hiveEvalTrendSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    hiveEvalTrendSettled,
    active,
  );
  const instances = sync.data?.[0]?.instances ?? [];
  // WI-6410: the resolver has carried degraded provenance since WI-6382, but
  // this view dropped it — `?? []` collapsed a FAILED read into the same value
  // as a genuinely empty one, so the empty state below claimed "a trend appears
  // after two or more evaluations" when the truth was that we could not read.
  const fault = snapshotFault(sync.error, sync.data?.[0], `${t("pot")} eval`);
  const latest = instances[0];
  const previous = instances[1];
  const compositeDelta =
    latest?.meanComposite != null && previous?.meanComposite != null
      ? latest.meanComposite - previous.meanComposite
      : null;
  const compositeDeltaMeta = deltaLabel(compositeDelta);
  // Reuse the BenchmarkTrend surface — the composite per generation, oldest→newest.
  const trendInstances: BenchmarkTrendInstance[] = instances.map((i) => ({
    instanceId: i.instanceId,
    codeSha: i.codeSha,
    createdAt: i.createdAt,
    totalRuns: i.totalRuns,
    successfulRuns: i.scoredRuns,
    meanComposite: i.meanComposite,
  }));
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : latest && (latest.fabricationRate ?? 0) === 0
          ? "good"
          : latest
            ? "warn"
            : "neutral",
    );
  }, [latest, onStatus, sync.error]);

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Activity}
        title={`${t("pot")} scoring`}
        question="Are orchestration scores improving?"
        signal={
          latest ? `${latest.scoredRuns}/${latest.totalRuns} scored` : undefined
        }
        tone={latest && (latest.fabricationRate ?? 0) === 0 ? "good" : "warn"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label={`Reload the ${t("pot")}-orchestration trend`}
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? `${t("pot")} eval unavailable`}
          onRetry={() => sync.invalidate()}
        />
      ) : !latest ? (
        // WI-6388: teaching copy per LearningVisualEmpty's own contract.
        // WI-6410: this branch now means a GENUINE empty — a failed read
        // renders as an error above.
        <LearningVisualEmpty
          icon={Activity}
          title={`No ${t("pot")}-eval runs`}
          body={`This view tracks how each ${t("pot", { lower: true })}'s evaluation scores move over time. A trend appears here after two or more evaluations.`}
        />
      ) : (
        <>
          <div className="pc-learning-visual__layout">
            <LearningHeroMetric
              eyebrow={shortSha(latest.codeSha)}
              value={compositeLabel(latest.meanComposite)}
              status={
                compositeDelta == null
                  ? "baseline"
                  : compositeDelta > 0
                    ? "improved"
                    : compositeDelta < 0
                      ? "regressed"
                      : "unchanged"
              }
              tone={
                compositeDelta == null
                  ? "accent"
                  : compositeDelta > 0
                    ? "good"
                    : compositeDelta < 0
                      ? "bad"
                      : "neutral"
              }
            >
              {compositeDelta == null
                ? "first generation"
                : `Δ ${compositeDeltaMeta.text}`}
            </LearningHeroMetric>
            <LearningComparisonBars
              title="Previous vs current"
              baselineName="Previous"
              treatmentName="Current"
              rows={[
                {
                  label: "Outcome gate",
                  baseline: previous?.outcomeGatePassRate ?? null,
                  treatment: latest.outcomeGatePassRate,
                  baselineLabel: pctLabel(
                    previous?.outcomeGatePassRate ?? null,
                  ),
                  treatmentLabel: pctLabel(latest.outcomeGatePassRate),
                  max: 1,
                  treatmentWins:
                    latest.outcomeGatePassRate != null &&
                    latest.outcomeGatePassRate >=
                      (previous?.outcomeGatePassRate ?? -Infinity),
                },
                {
                  label: "Critical path",
                  baseline: previous?.meanCriticalPathRatio ?? null,
                  treatment: latest.meanCriticalPathRatio,
                  baselineLabel: ratioLabel(
                    previous?.meanCriticalPathRatio ?? null,
                  ),
                  treatmentLabel: ratioLabel(latest.meanCriticalPathRatio),
                  treatmentWins:
                    latest.meanCriticalPathRatio != null &&
                    latest.meanCriticalPathRatio <=
                      (previous?.meanCriticalPathRatio ?? Infinity),
                },
                {
                  label: "Fabrication",
                  baseline: previous?.fabricationRate ?? null,
                  treatment: latest.fabricationRate,
                  baselineLabel: pctLabel(previous?.fabricationRate ?? null),
                  treatmentLabel: pctLabel(latest.fabricationRate),
                  max: 1,
                  treatmentWins:
                    latest.fabricationRate != null &&
                    latest.fabricationRate <=
                      (previous?.fabricationRate ?? Infinity),
                },
              ]}
            />
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Efficiency</span>
                  <strong>{compositeLabel(latest.meanEfficiency)}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Speed</span>
                  <strong>{compositeLabel(latest.meanSpeed)}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Scored</span>
                  <strong>{latest.scoredRuns}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Runs</span>
                  <strong>{latest.totalRuns}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>
          <BenchmarkTrend instances={trendInstances} />
        </>
      )}
    </section>
  );
}

// ─── Framework bake-off trend (plan-implementation-framework-2026-06-15 P-014) ──
//
// The A/B proof per bet: flip a flag OFF vs ON over the scored hive-eval corpus, diff the gated
// composite + outcome-gate pass rate. The SIBLING of the apiary + hive-orchestration trends — its
// own `learning.bakeoff` snapshot over hive_eval_bakeoff_deltas (migration 293). A regressed verdict
// auto-reverts the flag (P-015). Owner-gated (a real bake-off spends budget + needs the operator
// runtime) — graceful-empty until the first run lands.

const BAKEOFF_VERDICT_META: Record<
  BakeoffTrendRow["verdict"],
  { label: string; tone: "good" | "bad" | "flat"; color: string }
> = {
  improved: {
    label: "improved",
    tone: "good",
    color: CATEGORICAL.emerald400.hex,
  },
  regressed: { label: "regressed", tone: "bad", color: CATEGORICAL.red400.hex },
  neutral: { label: "neutral", tone: "flat", color: CATEGORICAL.slate400.hex },
  inconclusive: {
    label: "inconclusive",
    tone: "flat",
    color: CATEGORICAL.slate500.hex,
  },
};

function BakeoffTrendView({
  onStatus,
  active = true,
}: {
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const sync = useSyncQuery<{ rows: BakeoffTrendRow[] }>({
    queryName: "learning.bakeoff",
    args: {},
    staleTime: 30_000,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // same contract as the pre-existing sibling settle points: gated on the
  // PRIMARY read only, settles on a fault as well as success, gated on
  // `active` so a warm-but-inactive pane doesn't emit on a revisit that
  // never remounts (EI-19383745196363732).
  const bakeoffSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    bakeoffSettled,
    active,
  );
  const rows = sync.data?.[0]?.rows ?? [];
  // WI-6410: `sync.error` used to feed ONLY the onStatus tint, so a failed read
  // fell through to the "No bake-offs" empty state — whose body ("Results
  // appear here once one has finished") is an active lie when the truth is that
  // the read failed. The resolver already reports this; the view was discarding it.
  const fault = snapshotFault(sync.error, sync.data?.[0], "Framework bake-off");
  // Each bet's CURRENT standing — rows arrive newest-first, so the first verdict per flag is latest
  // (the same logic as the canonical latestVerdictByFlag formatter; inlined to keep the client bundle
  // free of an operator-core value import).
  const standings: Array<{
    flag: string;
    verdict: BakeoffTrendRow["verdict"];
  }> = [];
  const seenFlags = new Set<string>();
  for (const r of rows) {
    if (!seenFlags.has(r.flagKey)) {
      seenFlags.add(r.flagKey);
      standings.push({ flag: r.flagKey, verdict: r.verdict });
    }
  }
  const latest = rows[0];
  const latestMeta = latest ? BAKEOFF_VERDICT_META[latest.verdict] : null;
  const latestComposite = latest ? deltaLabel(latest.deltaMeanComposite) : null;
  const gateDeltaLabel = latest
    ? `${latest.deltaGatePassRate >= 0 ? "+" : "−"}${Math.abs(latest.deltaGatePassRate * 100).toFixed(1)}pp`
    : "—";
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : latest?.verdict === "improved"
          ? "good"
          : latest?.verdict === "regressed"
            ? "bad"
            : latest
              ? "neutral"
              : "neutral",
    );
  }, [latest, onStatus, sync.error]);
  const renderBakeoff = (r: BakeoffTrendRow, i: number) => {
    const dc = deltaLabel(r.deltaMeanComposite);
    const meta = BAKEOFF_VERDICT_META[r.verdict];
    return (
      <li
        key={`${r.flagKey}-${r.at}-${i}`}
        className="pc-learning__row pc-learning__row--bench"
        title={r.flagKey}
      >
        <span
          className="pc-learning__sev"
          style={{ background: meta.color }}
          aria-hidden
        />
        <span className="pc-learning__id" title={r.flagKey}>
          {r.flagKey.replace(/^papercusp-/, "")}
        </span>
        <span className="pc-learning__benchcell">
          <span
            className={`pc-learning__delta pc-learning__delta--${meta.tone}`}
          >
            {meta.label}
          </span>
          <span className={`pc-learning__delta pc-learning__delta--${dc.tone}`}>
            composite {dc.text}
          </span>
          {/* WI-6410: was `Δgate {toFixed(2)}` — the RAW fraction, while the hero
              metric above renders this SAME quantity ×100 as "pp". One number,
              two scales, one screen. Percentage points is the scale that reads,
              so both now use it. ("Δcomp"/"Δgate" also went to plain words: this
              is a public-release surface, and neither was defined anywhere on it.) */}
          <span className="pc-learning__benchmeta">
            outcome gate {r.deltaGatePassRate >= 0 ? "+" : "−"}
            {Math.abs(r.deltaGatePassRate * 100).toFixed(1)}pp
          </span>
        </span>
        <span className="pc-learning__meta">
          <span className="pc-learning__age">{whenLabel(r.at)}</span>
        </span>
      </li>
    );
  };

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Repeat2}
        title="Framework bake-off"
        question="Did the bet pay off?"
        signal={latestMeta?.label}
        tone={
          latest?.verdict === "improved"
            ? "good"
            : latest?.verdict === "regressed"
              ? "bad"
              : "neutral"
        }
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the framework bake-off trend"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />

      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Framework bake-off unavailable"}
          onRetry={() => sync.invalidate()}
        />
      ) : !latest || !latestMeta || !latestComposite ? (
        // WI-6388: teaching copy per LearningVisualEmpty's own contract.
        // WI-6410: reached only on a GENUINE empty now — a failed read renders
        // as an error above, so this copy's promise is honest again.
        <LearningVisualEmpty
          icon={Repeat2}
          title="No bake-offs"
          body="A bake-off runs two configurations against the same work and reports which did better. Results appear here once one has finished."
        />
      ) : (
        <>
          <div className="pc-learning-visual__layout">
            <LearningHeroMetric
              eyebrow={latest.flagKey.replace(/^papercusp-/, "")}
              value={latestComposite.text}
              status={latestMeta.label}
              tone={
                latest.verdict === "improved"
                  ? "good"
                  : latest.verdict === "regressed"
                    ? "bad"
                    : "warn"
              }
            >
              {gateDeltaLabel} outcome gate
            </LearningHeroMetric>
            <LearningComparisonBars
              title="Baseline vs treatment"
              rows={[
                {
                  label: "Composite lift",
                  baseline: 0,
                  treatment: Math.abs(latest.deltaMeanComposite),
                  baselineLabel: "0",
                  treatmentLabel: latestComposite.text,
                  max: Math.max(1, Math.abs(latest.deltaMeanComposite) * 1.25),
                  treatmentWins: latest.deltaMeanComposite > 0,
                },
                {
                  label: "Outcome gate",
                  baseline: 0,
                  treatment: Math.abs(latest.deltaGatePassRate),
                  baselineLabel: "0pp",
                  treatmentLabel: gateDeltaLabel,
                  max: Math.max(0.1, Math.abs(latest.deltaGatePassRate) * 1.25),
                  treatmentWins: latest.deltaGatePassRate > 0,
                },
              ]}
            />
            <LearningEvidenceRail>
              <div className="pc-learning-visual__evidence-grid">
                <div className="pc-learning-visual__evidence-metric">
                  <span>Verdict</span>
                  <strong>{latestMeta.label}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Gate</span>
                  <strong>{gateDeltaLabel}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Flags</span>
                  <strong>{standings.length}</strong>
                </div>
                <div className="pc-learning-visual__evidence-metric">
                  <span>Runs</span>
                  <strong>{rows.length}</strong>
                </div>
              </div>
            </LearningEvidenceRail>
          </div>

          <div className="pc-learning__sectionhead">
            <h2>Recent bake-offs</h2>
            <div
              className="pc-learning__standings"
              aria-label="Current flag standings"
            >
              {standings.slice(0, 4).map(({ flag, verdict }) => (
                <span
                  key={flag}
                  className={`pc-learning__delta pc-learning__delta--${BAKEOFF_VERDICT_META[verdict].tone}`}
                >
                  {flag.replace(/^papercusp-/, "")} ·{" "}
                  {BAKEOFF_VERDICT_META[verdict].label}
                </span>
              ))}
            </div>
          </div>
          <ul className="pc-learning__list">
            {rows.slice(0, 4).map(renderBakeoff)}
          </ul>
          {rows.length > 4 ? (
            <LearningDisclosure
              label="Earlier bake-offs"
              count={rows.length - 4}
            >
              <ul className="pc-learning__list">
                {rows.slice(4).map((row, i) => renderBakeoff(row, i + 4))}
              </ul>
            </LearningDisclosure>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Scout view (idea radar — routed ideas + tick health) ────────────────────

/** Rail → human label + accent for the routed-ideas rows. The canonical set is
    RoutedRail ('plan' | 'gym' | 'improvement' | 'instance') — open set, render
    whatever arrives. Built per-render from the active lexicon so the agent-noun
    in the plan-draft copy tracks the FLAGS.THE_HIVE pack (restore-pot-lexicon P-006). */
function railMeta(
  t: ReturnType<typeof useLexicon>,
): Record<string, { label: string; desc: string; color: string }> {
  return {
    plan: {
      label: "plan draft",
      desc: `A draft plan awaiting ${t("brain")}/owner triage — open it in the Create tab`,
      color: "var(--accent-strong, var(--accent))",
    },
    gym: {
      label: "gym",
      desc: "Seeded into the gym quality-diversity experiment archive",
      color: CATEGORICAL.emerald400.hex,
    },
    improvement: {
      label: "improvement",
      desc: "Filed as an improvement work-item (EI-…) in the backlog",
      color: CATEGORICAL.violet400.hex,
    },
    instance: {
      label: "instance",
      desc: "Registered as a genome-variant candidate for the apiary eval-battery",
      color: CATEGORICAL.pink400.hex,
    },
  };
}

/** Tone for one tick-economics cell (learning-tab-alignment P-002): an errored
    tick is red; a ran cycle that exhausted its budget without routing anything
    is amber (the WI-4482 starvation signature — spend with no yield); a
    completed run is green; a self-gated tick is idle/neutral. */
function tickTone(
  tk: ScoutTickEconomics,
): "good" | "warn" | "bad" | "idle" {
  if (tk.status === "error") return "bad";
  if (tk.status === "ran")
    return tk.stop === "budget-exhausted" && tk.routed === 0 ? "warn" : "good";
  return "idle";
}

/** Compact lens initials for the strip's chips ("first-principles" → "fp",
    "analogical" → "a") — the full name + count rides the chip tooltip. */
/** The grade a row should display: an in-flight optimistic owner write wins,
    then the snapshot's stored grade, else null (ungraded). */
interface EffectiveGrade {
  grade: number;
  feedback: string | null;
  gradedBy: string;
}

const GRADE_MEANING: Record<number, string> = {
  1: "a bad call — counts as a full loss for this lens",
  2: "weak — mostly a loss",
  3: "neutral — half win, half loss",
  4: "useful — mostly a win",
  5: "excellent — counts as a full win for this lens",
};

/** Attribution label per C-1's graded_by values ('owner' | 'Queen'). The raw
    auto-grader value is 'Queen'; it's routed to the active lexicon's brain word
    for display so the public (Pot) build never surfaces the swarm noun
    (restore-pot-lexicon P-006). */
const graderLabel = (gradedBy: string, brainWord: string): string =>
  gradedBy === "owner" ? "Owner" : gradedBy === "Queen" ? brainWord : gradedBy;

/** The tool-proxy response envelope varies (the parsed result | {result} | MCP
    content text) — unwrap whichever the dispatcher returns. */
function unwrapToolResult(d: unknown): Record<string, unknown> {
  const o = d as {
    content?: Array<{ type?: string; text?: string }>;
    result?: unknown;
  } | null;
  const text = Array.isArray(o?.content)
    ? o.content.find((c) => c?.type === "text")?.text
    : undefined;
  if (typeof text === "string") {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const inner = o?.result ?? d;
  return inner && typeof inner === "object"
    ? (inner as Record<string, unknown>)
    : {};
}

/** The 1–5 star radio row. Always interactive — the owner may regrade anything
    (D-004: owner grade is sovereign; the server derives gradedBy from the surface). */
function StarControl({
  value,
  onRate,
  busy = false,
  size = 13,
}: {
  value: number | null;
  onRate: (grade: number) => void;
  busy?: boolean;
  size?: number;
}) {
  return (
    <span
      className="pc-learning__stars"
      role="radiogroup"
      aria-label="Grade this idea 1 to 5"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Tooltip key={n} label={`★${n} — ${GRADE_MEANING[n]}`}>
          <button
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`Grade ${n} of 5`}
            className={`pc-learning__star${value != null && n <= value ? " is-on" : ""}`}
            disabled={busy}
            onClick={() => onRate(n)}
          >
            <Star
              size={size}
              aria-hidden
              fill={value != null && n <= value ? "currentColor" : "none"}
            />
          </button>
        </Tooltip>
      ))}
    </span>
  );
}

/** The note popover (open-state in nuqs `?grade=<ideaId>`): stars + a free-text
    critique saved together through `blender:grade-idea`. Mid-edit drafts are
    useState by design (nuqs is for the open-state only). */
function GradePanel({
  current,
  busy,
  onSave,
  onClose,
}: {
  current: EffectiveGrade | null;
  busy: boolean;
  onSave: (grade: number, feedback: string | null) => void;
  onClose: () => void;
}) {
  const t = useLexicon();
  const [grade, setGrade] = useState<number | null>(current?.grade ?? null);
  const [draft, setDraft] = useState(current?.feedback ?? "");
  return (
    <div
      className="pc-learning__gradepanel"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="pc-learning__gradepanelrow">
        <StarControl value={grade} onRate={setGrade} size={16} />
        <span className="pc-learning__gradepanelhint">
          {grade == null
            ? "Pick a grade — 5 counts as a win for this lens, 1 as a loss."
            : `★${grade} — ${GRADE_MEANING[grade]}`}
        </span>
        <button
          type="button"
          className="pc-learning__panelbtn pc-learning__gradecancel"
          onClick={onClose}
        >
          cancel
        </button>
      </div>
      {grade != null ? (
        <>
          <textarea
            value={draft}
            rows={2}
            maxLength={2000}
            aria-label="Grading note"
            placeholder={`Why? ${t("scout")} quotes recent grading notes to the next cycle’s ideators.`}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="pc-learning__gradepanelactions">
            <button
              type="button"
              className="pc-learning__panelbtn pc-learning__panelbtn--primary"
              disabled={busy}
              onClick={() => onSave(grade, draft.trim() ? draft.trim() : null)}
            >
              {busy ? "saving…" : "save grade"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** ms → compact human duration: "45s", "2m 0s", "1h 3m". */
function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Throughput view (queen-autonomous-execution B-11 / P-050): the Queen-loop's
 * operating-well yardstick — per-hive frontier depth, placements/wake,
 * cups-busy-vs-cap, stuck count, mean-time-to-complete, and the question-rung
 * split, read from hive_throughput_ticks (mig 261) via learning.hiveThroughput.
 */
function ThroughputView({
  hive = "",
  hiveReady = true,
  onStatus,
  active = true,
}: {
  /** Pot lens (pot-scope-all-learnings P-005): scopes the tick metrics and the
   *  soak verdicts to one pot; empty = every pot (no lens). */
  hive?: string;
  /** WI-5412 gate: don't fetch until the tab's hive lens is resolved. */
  hiveReady?: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const sync = useSyncQuery<HiveThroughputSnapshot>({
    queryName: "learning.hiveThroughput",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const soak = useSyncQuery<PotSoakReportSnapshot>({
    queryName: "learning.soakReport",
    args: hive ? { hive } : {},
    staleTime: 60_000,
    enabled: hiveReady,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch (WI-7263) —
  // gated on the PRIMARY read only (learning.hiveThroughput), deliberately
  // not on the soak-report leg: same rule as the sibling settle points in
  // ImprovementsView/LearningsView — a secondary read shouldn't have its cost
  // attributed to this interaction. Settles on a fault too, gated on `active`
  // so a warm-but-inactive pane doesn't emit on a revisit that never
  // remounts (EI-19383745196363732).
  const throughputSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    throughputSettled,
    active,
  );
  const snap = sync.data?.[0];
  const hives = snap?.hives ?? [];
  const soakByHive = new Map(
    (soak.data?.[0]?.hives ?? []).map((report) => [report.potSlug, report]),
  );
  // WI-6410: the throughput fault below folds in `soak.error` (the transport
  // half) but reads provenance from the THROUGHPUT snapshot only, so a soak read
  // that failed inside its own resolver was invisible. Checked separately
  // because the two reads fail independently and this one must not blank the view.
  const soakFault = snapshotFault(soak.error, soak.data?.[0], "Soak gate");
  // WI-6382/WI-6383: the resolver catches a read failure and returns a
  // SUCCESSFUL empty snapshot (never a 500), so `sync.error` alone left this
  // view's fault path unreachable — a broken or pre-migration install rendered
  // as the calm "no throughput recorded yet" card below, which then instructed
  // the reader to go start a pot and wait for data that could never arrive.
  // The degraded snapshot now carries provenance; fold it into the SAME branch.
  // Wiring it is part of restoring reachability, not scope creep: this view was
  // skipped by WI-6382's panel sweep precisely BECAUSE no user could open it.
  const fault = snapshotFault(sync.error ?? soak.error, snap, "Throughput");
  // The status is computed FIRST and the effect depends on the resulting STRING —
  // never on `hives`. This is the shape every sibling panel uses (FrontierPanel,
  // EkgPanel, …) and ThroughputView was the one that did not: it listed `hives` in
  // the deps, and `hives` is `snap?.hives ?? []`, a fresh array identity on every
  // render whenever the read has not landed. That re-fires the effect each render
  // instead of when the status actually changes — the ingredient a render loop
  // needs (WI-6383 found this view crashing the whole Learning tab live with React
  // #185, "Maximum update depth exceeded", while 86 jsdom tests stayed green).
  const status: LearningViewStatus = fault.failed
    ? "bad"
    : hives.some((hive) => !hive.operatingWell)
      ? "warn"
      : hives.length > 0
        ? "good"
        : "neutral";
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  return (
    <section className="pc-learning__section">
      {fault.failed ? (
        <LearningVisualError
          title={fault.message ?? "Throughput unavailable"}
          onRetry={() => {
            sync.invalidate();
            soak.invalidate();
          }}
        />
      ) : hives.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <strong>No throughput recorded yet</strong>
          <span>
            The {t("brain")} {t("pot", { lower: true })} loop records a tick
            every ~30s while a {t("pot", { lower: true })} is{" "}
            <strong>started</strong> with queued work. Start a{" "}
            {t("pot", { lower: true })} (or wait for its next wake) and its
            placement metrics appear here.
          </span>
        </div>
      ) : (
        hives.map((h) => {
          const m = h.latest;
          const report = soakByHive.get(h.potSlug);
          const rungs = m?.questionRungs ?? {};
          const rungTotal = Object.values(rungs).reduce<number>(
            (a, b) => a + (Number(b) || 0),
            0,
          );
          const tickMs = m?.tickAt ? Date.parse(m.tickAt) : NaN;
          const utilPct = m ? Math.round(m.utilization * 100) : 0;
          const saturated =
            !!m &&
            !h.operatingWell &&
            m.utilization >= 1 &&
            m.frontierDepth > 0;
          return (
            <div key={h.potSlug} className="pc-learning__throughputhive">
              <div
                className="pc-learning__flow"
                aria-label={`${h.potSlug} throughput health`}
              >
                <span
                  className={`pc-learning__flowchip ${h.operatingWell ? "pc-learning__flowchip--wd-good" : "pc-learning__flowchip--wd-warn"}`}
                  title={`The ${t("pot", { lower: true })} whose ${t("brain")}-loop throughput this is, how recently it ticked, and whether the loop is operating well (frontier draining, fleet not pegged, no stuck placements).`}
                >
                  <Activity size={11} aria-hidden />
                  {h.potSlug}
                  <strong>
                    {m && !Number.isNaN(tickMs)
                      ? whenLabel(tickMs)
                      : "no ticks"}
                  </strong>
                  <em>
                    {h.operatingWell ? "operating well" : "needs attention"}
                  </em>
                </span>
                {!report && soakFault.failed ? (
                  // WI-6410: `learning.soakReport` is a SECOND degraded-capable
                  // read in this view, and the fault check above only ever saw
                  // the throughput one — so a failed soak read silently removed
                  // the readiness chip, which reads as "no gate" rather than "we
                  // could not check the gate". A missing safety verdict must not
                  // look like an absent one.
                  <span
                    className="pc-learning__flowchip pc-learning__flowchip--wd-warn"
                    title={soakFault.message ?? "Soak gate unavailable"}
                  >
                    <ShieldCheck size={11} aria-hidden />
                    soak gate
                    <strong>UNKNOWN</strong>
                  </span>
                ) : report ? (
                  <span
                    className={`pc-learning__flowchip ${report.ready ? "pc-learning__flowchip--wd-good" : "pc-learning__flowchip--wd-warn"}`}
                    title={
                      report.ready
                        ? `Production-readiness gate held green for ${report.windowHours}h`
                        : `NOT-READY: ${report.reasons.join(" · ")}`
                    }
                  >
                    <ShieldCheck size={11} aria-hidden />
                    soak gate
                    <strong>{report.ready ? "READY" : "NOT-READY"}</strong>
                    <em>{report.windowHours}h window</em>
                  </span>
                ) : null}
              </div>

              {report ? (
                <div
                  className="pc-learning__flow"
                  aria-label={`${h.potSlug} production readiness`}
                >
                  <span
                    className="pc-learning__flowchip"
                    title="Machine-checkable production-readiness verdict over the rolling soak window."
                  >
                    <ShieldCheck size={11} aria-hidden />
                    reasons
                  </span>
                  {report.reasons.length === 0 ? (
                    <span className="pc-learning__lens">
                      <em>all thresholds held</em>
                      <strong>0</strong>
                    </span>
                  ) : (
                    report.reasons.slice(0, 5).map((reason, i) => (
                      <span
                        key={`${report.potSlug}-reason-${i}`}
                        className="pc-learning__lens"
                        title={reason}
                      >
                        <em>{reason}</em>
                      </span>
                    ))
                  )}
                </div>
              ) : null}

              <div
                className="pc-learning__scoreboard"
                aria-label={`${h.potSlug} throughput`}
              >
                <Stat
                  label="frontier"
                  value={m ? m.frontierDepth : "—"}
                  hint={`Ready work waiting for placement (todo items) — the queue the ${t("brain")} pours from.`}
                />
                <Stat
                  label={`${t("contributor", { plural: true, lower: true })} busy`}
                  value={m ? `${m.cupsBusy}/${m.cupsCap}` : "—"}
                  tone={saturated ? "human" : "good"}
                  hint={`Live placed ${t("contributor", { plural: true, lower: true })} vs the fleet ceiling. Pegged at cap with work still queued = starvation (raise the ceiling / widen the credential pool, D-006).`}
                />
                <Stat
                  label="utilization"
                  value={m ? `${utilPct}%` : "—"}
                  hint={`Fleet utilization: ${t("contributor", { plural: true, lower: true })} busy ÷ cap.`}
                />
                <Stat
                  label="placed / wake"
                  value={m ? m.placements : "—"}
                  tone="auto"
                  hint={`${t("contributor", { plural: true })} newly placed since the previous tick — how fast the ${t("brain")} fans work out.`}
                />
                <Stat
                  label="completed"
                  value={m ? m.completed : "—"}
                  tone="auto"
                  hint={`${t("contributor", { plural: true })} that finished in the tick window.`}
                />
                <Stat
                  label="avg complete"
                  value={formatDurationMs(m?.mttcMs)}
                  hint={`Mean-time-to-complete over ${t("contributor", { plural: true, lower: true })} that finished — how long a placement takes.`}
                />
                <Stat
                  label="stuck"
                  value={m ? m.stuckCount : "—"}
                  {...(m && m.stuckCount > 0 ? { tone: "human" as const } : {})}
                  hint={`Placed ${t("contributor", { plural: true, lower: true })} with a stale heartbeat — placements that stopped advancing and need a recovery wake (the placement watchdog, P-020).`}
                />
                <Stat
                  label="questions"
                  value={rungTotal}
                  hint={`${t("contributor")} questions resolved this window, split by rung below. Lights up when the question-ladder (B-10/B-17) lands; 0 until then.`}
                />
              </div>

              {rungTotal > 0 ? (
                <div
                  className="pc-learning__flow"
                  aria-label={`${h.potSlug} question rungs`}
                >
                  <span
                    className="pc-learning__flowchip"
                    title={`Where ${t("contributor", { lower: true })} questions resolved: ${t("contributor", { lower: true })}-self / peer-vote / ${t("brain")} / owner. The lower the rung, the less the owner was needed.`}
                  >
                    <HelpCircle size={11} aria-hidden />
                    question rungs
                  </span>
                  {Object.entries(rungs).map(([rung, count]) => (
                    <span
                      key={rung}
                      className="pc-learning__lens"
                      title={`${String(count)} question(s) resolved at the ${rung} rung`}
                    >
                      <em>{rung}</em>
                      <strong>{String(count)}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      <button
        type="button"
        className="pc-learning__refresh"
        aria-label={`Reload ${t("pot", { lower: true })} throughput`}
        disabled={sync.fetching || soak.fetching}
        onClick={() => {
          sync.invalidate();
          soak.invalidate();
        }}
      >
        <RefreshCw size={13} aria-hidden />
      </button>
    </section>
  );
}

/**
 * Cadence card (learning-tab-visibility P-001): the live volume-gate state.
 * Score/threshold/lane counts arrive server-derived from the gate's own reader
 * (never re-computed here); this renders them as a score bar + per-lane chips.
 */
function CadenceCard({
  cadence,
  scoutWord,
}: {
  cadence: ScoutCadenceState;
  scoutWord: string;
}) {
  const pct =
    cadence.threshold > 0
      ? Math.min(100, Math.round((cadence.score / cadence.threshold) * 100))
      : 0;
  const armed = cadence.score >= cadence.threshold;
  const quiet = cadence.score <= 0;
  const wmMs = cadence.watermarkAt ? Date.parse(cadence.watermarkAt) : NaN;
  const verdict = armed
    ? "ready — the next cycle fires within ~30s"
    : quiet
      ? "quiet — no new signal, so nothing fires (and nothing is spent)"
      : "collecting signal — fires at the threshold, or on the hourly heartbeat";
  return (
    <div
      className="pc-learning__cadence"
      role="group"
      aria-label={`${scoutWord} firing state`}
      title={`${scoutWord} fires on DATA VOLUME, not a clock: a 30s sweep recounts per-lane "new signal since the last successful cycle"; the weighted score (shown here, from the gate's own reader) fires a cycle at ≥${cadence.threshold}, a zero score withholds everything, and a heartbeat fires at least every ${Math.round(cadence.maxIntervalSec / 60)}m regardless.`}
    >
      <span className="pc-learning__cadence-head">
        <Gauge size={12} aria-hidden />
        <strong>
          signal {Math.round(cadence.score * 10) / 10} of {cadence.threshold}{" "}
          needed
        </strong>
        <span
          className="pc-learning__cadence-bar"
          role="progressbar"
          aria-valuenow={Math.round(cadence.score)}
          aria-valuemin={0}
          aria-valuemax={cadence.threshold}
        >
          <span
            className={`pc-learning__cadence-fill${armed ? " pc-learning__cadence-fill--armed" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <em>{verdict}</em>
      </span>
      <span
        className="pc-learning__cadence-lanes"
        title={cadence.lanes
          .filter((l) => l.count > 0)
          .map((l) => `${l.count} ${l.lane.replace(/-/g, " ")} × weight ${l.weight} = ${l.count * l.weight}`)
          .join("\n")}
      >
        {cadence.lanes.some((l) => l.count > 0) ? (
          <>
            counting:{" "}
            {cadence.lanes
              .filter((l) => l.count > 0)
              .map((l) => `${l.count} ${l.lane.replace(/-/g, " ")}`)
              .join(", ")}
          </>
        ) : null}
        {cadence.lanes.every((l) => l.count === 0) ? (
          <span className="pc-learning__flowchip" title="No lane has accumulated new signal since the last successful cycle.">
            no new signal in any lane
          </span>
        ) : null}
        {!Number.isNaN(wmMs) ? (
          <span
            className="pc-learning__flowchip"
            title="The accumulator baseline — counts are 'new since this instant' (the last successful cycle)."
          >
            since {whenLabel(wmMs)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// The ideation surface is mounted directly inside Improve → Ideas.
/**
 * The cycle engine's instruments, lifted out of the retired Ideas view.
 *
 * Everything here answers "is the machine that MAKES ideas working" — the
 * idea→work funnel, the drift markers, what will fire the next cycle, and the
 * per-tick economics. It lives behind the Improve view's one labelled
 * disclosure: the gauges are on demand, the plain summary is always up top.
 */
function LoopEngineInstruments({
  snap,
  scoutWord,
}: {
  snap: ScoutSnapshot | undefined;
  scoutWord: string;
}) {
  const tick = snap?.lastTick ?? null;
  const tickMs = tick?.at ? Date.parse(tick.at) : NaN;
  // Older server snapshots lack these fields — degrade to an empty strip or a
  // neutral verdict, never a crash.
  const econTicks = snap?.ticks ?? [];
  const health = snap?.health ?? { status: "neutral" as const, markers: [] };
  const cadence = snap?.cadence ?? null;
  return (
    <>
      {/* The idea→work funnel LEADS (owner ask 2026-07-19e): the outcome story
          first, the machinery below it. */}
      {/* The funnel speaks the SAME vocabulary as the row chips below it
          (P-004) — a reader should not have to translate between the summary
          and the list. Stage 1 is the mouth (every idea); the drop from it to
          `approved` is the "not ready yet" population, so that word needs no
          column of its own here. */}
      {snap?.improveFunnel ? (
        <div className="pc-learning__funnel" aria-label="Idea-to-work funnel">
          <span title="Every idea a cycle routed onto a rail (work item, gym seed, plan, benchmark).">
            <strong>{snap.improveFunnel.routed}</strong>
            <small>ideas</small>
          </span>
          <i aria-hidden>→</i>
          <span title={`Filed as work on the improvement rail. ${PIPELINE_STATES.approved.desc}`}>
            <strong>{snap.improveFunnel.filed}</strong>
            <small>{PIPELINE_STATES.approved.label}</small>
          </span>
          <i aria-hidden>→</i>
          <span title={PIPELINE_STATES["in-flight"].desc}>
            <strong>{snap.improveFunnel.claimed}</strong>
            <small>{PIPELINE_STATES["in-flight"].label}</small>
          </span>
          <i aria-hidden>→</i>
          <span
            className={snap.improveFunnel.done > 0 ? "is-good" : undefined}
            title={
              // Name the abandoned population rather than hiding it: it is
              // excluded from `shipped` by design (EI-18792873324746237), and
              // an unexplained gap between stages invites the reader to assume
              // the number is broken — which, until this fix, it was.
              snap.improveFunnel.dropped > 0
                ? `${PIPELINE_STATES.shipped.desc} ${snap.improveFunnel.dropped} more were dropped — abandoned, not shipped, and never counted here.`
                : PIPELINE_STATES.shipped.desc
            }
          >
            <strong>{snap.improveFunnel.done}</strong>
            <small>{PIPELINE_STATES.shipped.label}</small>
          </span>
        </div>
      ) : null}
      {health.markers.length > 0 ? (
        <ul className="pc-learning__warnlist" aria-label="Loop health warnings">
          {health.markers.map((m) => (
            <li
              key={m.key}
              className={m.severity === "bad" ? "is-bad" : "is-warn"}
              title={`Instruments the '${m.rubricCriterion}' criterion of the blender-release-readiness rubric.`}
            >
              <AlertTriangle size={12} aria-hidden />
              {m.summary}
            </li>
          ))}
        </ul>
      ) : null}

      {/* The LIVE firing state — per-lane pending signal and the weighted score
          against the volume gate's threshold, from the same reader + score
          function the gate consumes. Answers "why isn't it firing / what will
          make it fire" without a PG query. */}
      {cadence ? <CadenceCard cadence={cadence} scoutWord={scoutWord} /> : null}

      {/* Tick economics: each recent tick's stop reason, spend, generated→routed
          funnel and lens mix — the columns where the 17-day WI-4482 lens
          collapse and the budget-exhausted starvation lived, invisibly. */}
      <div
        className="pc-learning__tickstrip pc-learning__tickstrip--rows"
        role="list"
        aria-label={`${scoutWord} tick economics, newest first`}
      >
        {econTicks.length === 0 ? (
          <span
            className="pc-learning__flowchip"
            title={`${scoutWord} records a row per tick (stop reason, spend, ideas generated/routed) — no ticks recorded yet.`}
          >
            <Radar size={11} aria-hidden />
            last tick{" "}
            <strong>
              {tick && !Number.isNaN(tickMs) ? whenLabel(tickMs) : "none yet"}
            </strong>
          </span>
        ) : (
          econTicks.map((tk, i) => {
            const ms = tk.at ? Date.parse(tk.at) : NaN;
            const tone = tickTone(tk);
            const lensPairs = Object.entries(tk.lenses).sort(
              (a, b) => b[1] - a[1],
            );
            const spend =
              tk.spendUsd != null ? `$${tk.spendUsd.toFixed(2)}` : null;
            const tip =
              tk.status === "ran"
                ? `${!Number.isNaN(ms) ? whenLabel(ms) : ""} · ${tk.stop ?? "ran"} — generated ${tk.generated}, pruned ${tk.deduped}, routed ${tk.routed}${spend ? `, spend ${spend}` : ""}${lensPairs.length > 0 ? ` · lenses: ${lensPairs.map(([l, n]) => `${l}×${n}`).join(" ")}` : tk.routed === 0 ? " · nothing routed" : ""}`
                : tk.status === "gated"
                  ? `${!Number.isNaN(ms) ? whenLabel(ms) : ""} · self-gated (${tk.stop ?? "gate"}) — no cycle ran, no spend`
                  : `${!Number.isNaN(ms) ? whenLabel(ms) : ""} · tick errored${tk.stop ? `: ${tk.stop}` : ""}`;
            return (
              <span
                key={tk.cycleId ?? tk.at ?? i}
                role="listitem"
                className={`pc-learning__tickrow pc-learning__tickrow--${tone}`}
                title={tip}
              >
                <em>{!Number.isNaN(ms) ? whenLabel(ms) : "—"}</em>
                <strong>
                  {tk.status === "ran"
                    ? `${tk.generated}→${tk.routed}`
                    : (tk.status ?? "?")}
                </strong>
                <span className="pc-learning__tickwhat">
                  {tk.status === "ran"
                    ? `generated ${tk.generated}, routed ${tk.routed} · ${tk.stop ?? "ran"}`
                    : tk.status === "gated"
                      ? `skipped — ${tk.stop ?? "gate"}`
                      : `error — ${tk.stop ?? "unknown"}`}
                </span>
                {spend ? (
                  <span className="pc-learning__tickspend">{spend}</span>
                ) : null}
              </span>
            );
          })
        )}
      </div>
    </>
  );
}

/** The ideator's learned creative-lens steering — always visible under a
 *  standard header (owner ask 2026-07-19: "should always be visible, it never
 *  takes up much space"). Shown as shares of the total so they read as "how the
 *  generator will lean" rather than as raw weights. */
function LensWeights({
  snap,
  scoutWord,
}: {
  snap: ScoutSnapshot | undefined;
  scoutWord: string;
}) {
  const lensEntries = useMemo<Array<[string, number]>>(() => {
    const w = snap?.lensWeights;
    if (!w) return [];
    const entries = Object.entries(w).filter(
      ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    );
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length === 0 || sum <= 0) return [];
    return entries
      .map(([k, v]) => [k, Math.round((v / sum) * 100)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  }, [snap]);
  if (lensEntries.length === 0) return null;
  return (
    <>
      <div className="pc-learning__sectionhead pc-learning__sectionhead--desc">
        <h2>Lens weights</h2>
        <span
          className="pc-learning__sectionsub"
          title={`${scoutWord} picks its creative lenses with these sampling weights — learned from routed-idea outcomes and grades (a ★5 counts as a win, a ★1 as a loss; a grade beats the system's own outcome guess).`}
        >
          the ideator's learned creative-lens steering — raised by wins and good
          grades
        </span>
      </div>
      <div className="pc-learning__flow" aria-label="Lens sampling weights">
        {lensEntries.map(([lens, share]) => (
          <span
            key={lens}
            className="pc-learning__lens"
            title={`${lens}: ${share}% of next cycle's lens sampling — raised by wins and good grades, lowered by losses and poor grades.`}
          >
            <em>{lens}</em>
            <span className="pc-learning__lensbar" aria-hidden>
              <span style={{ width: `${share}%` }} />
            </span>
            <strong>{share}%</strong>
          </span>
        ))}
      </div>
    </>
  );
}

// ─── Learnings view (a hive's editable shared memory — knowledge-packs P-008) ──

type HiveLearningRowT = HiveLearningsSnapshot["rows"][number];

function learningPreview(text: string): { headline: string; preview: string } {
  const normalized = text.replace(/\s+/g, " ").trim();
  const boundary = [/\.\s/, /:\s/, / —\s/, /;\s/]
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 32 && index <= 120)
    .sort((a, b) => a - b)[0];
  const cut =
    boundary ??
    (normalized.length > 104
      ? normalized.lastIndexOf(" ", 104)
      : normalized.length);
  const safeCut =
    cut > 0 ? cut + (boundary == null ? 0 : 1) : normalized.length;
  return {
    headline: normalized.slice(0, safeCut).trim(),
    preview: normalized.slice(safeCut).trim(),
  };
}

function learningProvenance(
  createdBy: string | null | undefined,
  kind: string | null | undefined,
  scoutLabel: string,
) {
  const source = `${createdBy ?? ""} ${kind ?? ""}`.toLowerCase();
  if (/owner|user|human/.test(source))
    return { Icon: UserRound, tone: "owner", label: "Owner retained" };
  if (/queen|mug|brain/.test(source))
    return { Icon: Brain, tone: "brain", label: "Learning loop retained" };
  if (/scout|idea/.test(source))
    return { Icon: Radar, tone: "scout", label: `${scoutLabel} retained` };
  if (/migration|system/.test(source))
    return { Icon: ShieldCheck, tone: "system", label: "System retained" };
  if (/reference|project/.test(source))
    return { Icon: BookOpen, tone: "reference", label: "Project reference" };
  return { Icon: Sparkles, tone: "agent", label: "Agent retained" };
}

function LearningsView({
  hive,
  hiveReady,
  onStatus,
  active = true,
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
  /** True when this pane is the SELECTED view — see useInteractionSettle. */
  active?: boolean;
}) {
  const t = useLexicon();
  const [selectedLearning, setSelectedLearning] = useQueryState(
    "lretain",
    parseAsString,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [, setLviewNav] = useQueryState("lview", parseAsString);
  const [, setTabNav] = useQueryState("tab", parseAsString);
  const [, setCreateViewNav] = useQueryState("view", parseAsString);
  const [, setPlanNav] = useQueryState("plan", parseAsString);

  // WI-6384: gated on `hiveReady` ALONE, like every sibling read in this view.
  // It used to also require `hive.length > 0`, so selecting All Pots — the
  // BROADEST lens — disabled the main list while the extras strip beside it
  // kept reporting workspace-wide counts. The resolver now serves '' as the
  // workspace-wide rollup the tab's contract always promised.
  const sync = useSyncQuery<HiveLearningsSnapshot>({
    queryName: "learning.hive",
    args: hive ? { hive } : {},
    enabled: hiveReady,
    staleTime: 30_000,
  });
  // Perf settle point for PERF_INTERACTIONS.learningViewSwitch — same contract
  // as the improvements view above (EI-19375505819043214): gated on the PRIMARY
  // read only, settles on a fault as well as success. learning.hive measured
  // 230,147B on the live operator, the second-heaviest read on this tab, so
  // leaving it unmeasured left the payload-cost question unanswerable for it.
  //
  // Gated on `active` as well: this pane is kept MOUNTED when the user switches
  // away (warmViews), so on a revisit `learningsSettled` is already true and
  // never changes — an effect keyed on it alone would never re-run and the
  // switch would measure nothing (EI-19383745196363732).
  const learningsSettled =
    !sync.loading && (sync.data !== undefined || Boolean(sync.error));
  useInteractionSettle(
    PERF_INTERACTIONS.learningViewSwitch,
    learningsSettled,
    active,
  );
  // The rest of what the colony keeps (WI-5412, owner ask: lens weights,
  // rubric changes, insight docs, and recipes are retained learning too) +
  // the banked-this-week strip counts. One slim read; every leg degrades
  // independently server-side.
  const extras = useSyncQuery<RetainExtrasSnapshot | undefined>({
    queryName: "learning.retain",
    args: hive ? { hive } : {},
    enabled: hiveReady,
    staleTime: 60_000,
  });
  // Shape-guard the extras row: a server without the learning.retain resolver
  // (or a mis-routed read) must degrade to "sections absent", never crash the
  // whole Retain render.
  const extrasRaw = extras.data?.[0] as RetainExtrasSnapshot | undefined;
  const extrasSnap =
    extrasRaw && typeof extrasRaw === "object" && extrasRaw.banked
      ? extrasRaw
      : undefined;
  // Same share-of-total render as the Ideas view's lens strip — one visual
  // language for "how the ideator will lean".
  const retainLensEntries = useMemo<Array<[string, number]>>(() => {
    const w = extrasSnap?.lensWeights;
    if (!w) return [];
    const entries = Object.entries(w).filter(
      ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    );
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length === 0 || sum <= 0) return [];
    return entries
      .map(([k, v]) => [k, Math.round((v / sum) * 100)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  }, [extrasSnap]);
  const snap = sync.data?.[0];
  const rows = snap?.rows ?? [];
  const filtered = searchQuery.trim()
    ? rows.filter((row) =>
        row.text.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : rows;
  const selectedRow = selectedLearning
    ? (rows.find((row) => row.id === selectedLearning) ?? null)
    : null;
  const primaryRows = [
    ...(selectedRow && !filtered.slice(0, 6).includes(selectedRow)
      ? [selectedRow]
      : []),
    ...filtered,
  ]
    .filter(
      (row, index, all) =>
        all.findIndex((item) => item.id === row.id) === index,
    )
    .slice(0, 6);
  const primaryIds = new Set(primaryRows.map((row) => row.id));
  const earlierRows = filtered.filter((row) => !primaryIds.has(row.id));
  const selectedProvenance = selectedRow
    ? learningProvenance(selectedRow.createdBy, selectedRow.kind, t("scout"))
    : null;
  const SelectedProvenanceIcon = selectedProvenance?.Icon;
  useEffect(() => {
    onStatus?.(sync.error ? "bad" : rows.length > 0 ? "good" : "neutral");
  }, [onStatus, rows.length, sync.error]);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

  const forget = async (row: HiveLearningRowT) => {
    const ok = await askConfirm({
      title: "Remove this learning?",
      body: row.text.slice(0, 160),
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetch(`/api/user/memory?id=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
    } finally {
      sync.invalidate();
    }
  };
  const edit = async (row: HiveLearningRowT) => {
    const next = await askPrompt({
      title: "Edit learning",
      label: "Learning text",
      body: "Agents recall the exact text.",
      defaultValue: row.text,
      submitLabel: "Save",
      validate: (value) => (value.trim() ? null : "Learning text is required."),
    });
    if (next == null || !next.trim() || next === row.text) return;
    try {
      await fetch("/api/user/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, text: next.trim() }),
      });
    } finally {
      sync.invalidate();
    }
  };

  const actionBtn: React.CSSProperties = {
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--fg-dim)",
    cursor: "pointer",
    fontSize: 11,
    padding: "1px 7px",
  };

  const renderLearning = (r: HiveLearningRowT) => {
    const selected = selectedLearning === r.id;
    const preview = learningPreview(r.text);
    const provenance = learningProvenance(r.createdBy, r.kind, t("scout"));
    const ProvenanceIcon = provenance.Icon;
    return (
      <li
        key={r.id}
        className={`pc-learning__row pc-learning__row--retained${selected ? " is-selected" : ""}`}
        style={{ alignItems: "flex-start" }}
      >
        <span
          className="pc-learning__sev"
          style={{
            background: "var(--good)",
            marginTop: 5,
          }}
          aria-hidden
        />
        <button
          type="button"
          className="pc-learning__retainedmain"
          aria-expanded={selected}
          aria-label={`${selected ? "Close" : "Open"} learning ${preview.headline}`}
          onClick={() => void setSelectedLearning(selected ? null : r.id)}
        >
          <span className="pc-learning__retainedsummary">
            <strong>{preview.headline}</strong>
            {preview.preview ? <span>{preview.preview}</span> : null}
          </span>
          <span
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginTop: 3,
              fontSize: 10.5,
              color: "var(--fg-mute)",
            }}
          >
            {r.createdBy || r.kind ? (
              <Tooltip
                label={`${provenance.label}${r.createdBy ? ` · ${r.createdBy}` : ""}${r.kind ? ` · ${r.kind}` : ""}`}
              >
                <span
                  className={`pc-learning__provenance is-${provenance.tone}`}
                  aria-label={`${provenance.label}${r.createdBy ? ` by ${r.createdBy}` : ""}`}
                >
                  <ProvenanceIcon size={10} aria-hidden />
                </span>
              </Tooltip>
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      {confirmEl}
      {promptEl}
      <section className="pc-learning__section">
        {/* WI-5412 item 5: ONE concept, one heading — the page was titled
            "Shared learnings" over a list headed "Shared memory", two names
            for the same store. */}
        <LearningPageHeader
          icon={Brain}
          title="Shared memory"
          signal={snap ? `${rows.length} retained` : undefined}
          tone={rows.length > 0 ? "good" : "neutral"}
          action={
            <div className="pc-learning__retaincontrols">
              {searchOpen ? (
                <input
                  autoFocus
                  type="search"
                  aria-label="Search retained learnings"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              ) : null}
              <button
                type="button"
                className="pc-learning__refresh"
                aria-label={
                  searchOpen ? "Close retained search" : "Search learnings"
                }
                onClick={() => {
                  setSearchOpen((current) => !current);
                  if (searchOpen) setSearchQuery("");
                }}
              >
                {searchOpen ? (
                  <XCircle size={13} aria-hidden />
                ) : (
                  <Search size={13} aria-hidden />
                )}
              </button>
              <button
                type="button"
                className="pc-learning__refresh"
                aria-label="Reload the learnings"
                disabled={sync.fetching}
                onClick={() => sync.invalidate()}
              >
                <RefreshCw size={13} aria-hidden />
              </button>
            </div>
          }
        />

        {/* Fleet-lessons candidate review (learning-tab-visibility P-002): the
            retention loop's human gate — cross-hive recurring lessons staged by
            the recurrence-escalation sweep, awaiting owner adopt/dismiss into
            the fleet-lessons pack. Self-labeling; renders nothing when empty. */}
        <KnowledgePackCandidates />

        {/* "What stuck?" — the banked-this-week strip (WI-5412, owner: "add
            this"). Counts + link-outs only; never a queue duplicate. */}
        <div className="pc-learning__flow" aria-label="Banked this week">
          <span
            className="pc-learning__flowchip"
            title={`Rows in this ${t("pot", { lower: true })}'s shared memory pool — every agent recalls these while working.`}
          >
            <Brain size={11} aria-hidden />
            <strong>{rows.length}</strong> learnings retained
          </span>
          <Tooltip label="Improvements filed in the trailing 7 days — open the Improvements backlog.">
            <button
              type="button"
              className="pc-learning__flowchip pc-learning__flowchip--link"
              onClick={() => void setLviewNav("improvements")}
            >
              <Sparkles size={11} aria-hidden />
              <strong>{extrasSnap?.banked.improvementsFiled7d ?? "—"}</strong>{" "}
              improvements filed
              <em>7d</em>
            </button>
          </Tooltip>
          <Tooltip label="Plans drafted in the trailing 7 days — open the Plans board.">
            <button
              type="button"
              className="pc-learning__flowchip pc-learning__flowchip--link"
              onClick={() => {
                void setCreateViewNav("plans");
                void setTabNav("plans");
              }}
            >
              <GitBranch size={11} aria-hidden />
              <strong>{extrasSnap?.banked.plansDrafted7d ?? "—"}</strong> plans
              drafted
              <em>7d</em>
            </button>
          </Tooltip>
        </div>

        {/* WI-6384 (residual): there used to be a `hive === ""` short-circuit
            HERE that printed "No pots" before anything looked at `snap`. The
            resolver and the query gate above had already been fixed to serve
            the workspace-wide rollup for '', so the rollup arrived and was
            discarded one layer below the fix — the All-Pots lens still read as
            empty. "No pots" is not a render-time fact either: when the
            workspace genuinely has no pots the resolver says so as
            `unavailable('no pots registered in this workspace')`, which the
            branch below renders WITH its reason. Selecting the broadest lens
            now shows the broadest result. */}
        {sync.loading && !snap ? (
          <p className="pc-learning__quietempty">
            Loading the {t("pot", { lower: true })}&rsquo;s shared memory…
          </p>
        ) : snap?.unavailable ? (
          // Name the CAUSE. "unavailable" with no reason is a dead end for the
          // reader (owner report 2026-07-25 — the real cause was a corrupted
          // mem0ai install, invisible from this screen).
          <LearningVisualError
            title={
              snap.unavailableReason
                ? `Shared memory unavailable — ${snap.unavailableReason}`
                : "Shared memory unavailable"
            }
            onRetry={() => sync.invalidate()}
          />
        ) : filtered.length === 0 ? (
          <div className="pc-learning__quietempty" role="status">
            <Brain size={14} aria-hidden />
            <span>No retained learnings</span>
          </div>
        ) : (
          <div
            className={`pc-learning__retainlayout${selectedRow ? " has-detail" : ""}`}
          >
            <div className="pc-learning__retainindex">
              <ul className="pc-learning__list">
                {primaryRows.map(renderLearning)}
              </ul>
              {earlierRows.length > 0 ? (
                <LearningDisclosure
                  label="Earlier retained learnings"
                  count={earlierRows.length}
                >
                  <ul className="pc-learning__list">
                    {earlierRows.map(renderLearning)}
                  </ul>
                </LearningDisclosure>
              ) : null}
            </div>
            {selectedRow && selectedProvenance && SelectedProvenanceIcon ? (
              <aside
                className="pc-learning__retaindetail"
                aria-label="Selected learning"
              >
                <header>
                  <span
                    className={`pc-learning__provenance is-${selectedProvenance.tone}`}
                    title={selectedProvenance.label}
                  >
                    <SelectedProvenanceIcon size={11} aria-hidden />
                  </span>
                  <button
                    type="button"
                    aria-label="Close selected learning"
                    onClick={() => void setSelectedLearning(null)}
                  >
                    <XCircle size={14} aria-hidden />
                  </button>
                </header>
                <p>{selectedRow.text}</p>
                <footer>
                  <button
                    type="button"
                    style={actionBtn}
                    onClick={() => void edit(selectedRow)}
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    style={actionBtn}
                    onClick={() => void forget(selectedRow)}
                  >
                    remove
                  </button>
                </footer>
              </aside>
            ) : null}
          </div>
        )}

        {/* Everything ELSE the colony keeps (WI-5412, owner: "add these there
            too") — lens weights, rubric changes, insight runbooks, recipes.
            Compact disclosures: Retain answers "what does the system know?",
            it never duplicates the stores' own management surfaces. */}
        {extrasSnap ? (
          <>
            <div className="pc-learning__sectionhead">
              <h2>Also retained</h2>
              <span
                className="pc-learning__muted"
                title="Learning the loop keeps outside the shared memory pool: lens steering, rubric changes, agent-insight runbooks, and code recipes."
              >
                other things the loop has learned
              </span>
            </div>
            {/* Idea-derived outcomes (owner ask 2026-07-19): the idea → plan/
                work-item → DONE chain, visibly banked here — the loop's wins
                are retained knowledge, not just lens-weight nudges. */}
            {(extrasSnap.shippedFromIdeas?.length ?? 0) > 0 ? (
              <LearningDisclosure
                label="Shipped from ideas"
                subtitle="ideas whose routed plan / work item reached an outcome"
                count={extrasSnap.shippedFromIdeas.length}
              >
                <ul
                  className="pc-learning__draftlist"
                  aria-label="Idea-derived shipped outcomes"
                >
                  {extrasSnap.shippedFromIdeas.map((d) => {
                    const doneMs = d.completedAt ? Date.parse(d.completedAt) : NaN;
                    // Server-stamped (RetainShippedIdea.shipped). This used to
                    // be a hand-typed state list here, which drifted from the
                    // unified enum and scored a `done` item as not-a-win while
                    // scoring an abandoned one as a win (EI-18792873324746237).
                    const good = d.shipped;
                    return (
                      <li key={d.ideaId} className="pc-learning__draftrow">
                        <CheckCircle2 size={11} aria-hidden />
                        <strong title={d.routedRef}>{d.title ?? d.routedRef}</strong>
                        <em>{d.rail}</em>
                        <span
                          className={`pc-learning__flowchip${good ? " pc-learning__flowchip--wd-good" : ""}`}
                          title={`The routed artifact's end state (${d.routedRef}).`}
                        >
                          {d.outcome}
                        </span>
                        {!Number.isNaN(doneMs) ? (
                          <span className="pc-learning__draftwhen">
                            {whenLabel(doneMs)}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </LearningDisclosure>
            ) : null}
            {/* Blender-generated plans (D-004 / P-012): every plan the ideation
                loop routed into the plan store — drafted included, not only the
                shipped outcomes above. Rows deep-link to the Plans board via
                the same nuqs params ImprovementsView's openPlan uses. */}
            {(extrasSnap.blenderPlans?.length ?? 0) > 0 ? (
              <LearningDisclosure
                label="Plans from ideas"
                subtitle="plans the ideation loop drafted into the plan store"
                count={extrasSnap.blenderPlans.length}
              >
                <ul
                  className="pc-learning__retainextras"
                  aria-label="Blender-generated plans"
                >
                  {extrasSnap.blenderPlans.map((p) => {
                    const routedMs = p.routedAt ? Date.parse(p.routedAt) : NaN;
                    return (
                      <li key={p.planSlug}>
                        <GitBranch size={11} aria-hidden />
                        <button
                          type="button"
                          className="pc-learning__retainlink"
                          title={`${p.planSlug} — open on the Plans board`}
                          onClick={() => {
                            void setPlanNav(p.planSlug);
                            void setCreateViewNav("plans");
                            void setTabNav("plans");
                          }}
                        >
                          {p.title}
                        </button>
                        {p.status ? (
                          <span
                            className="pc-learning__chip"
                            title="Plan lifecycle status"
                          >
                            {p.status}
                          </span>
                        ) : null}
                        {p.ideaTitle ? (
                          <em
                            className="pc-learning__retainidea"
                            title={`Origin idea ${p.ideaId} (${p.lens} lens)`}
                          >
                            <Lightbulb size={10} aria-hidden />
                            {p.ideaTitle}
                          </em>
                        ) : null}
                        {!Number.isNaN(routedMs) ? (
                          <span
                            className="pc-learning__age"
                            title="When the idea was routed into the plan store"
                          >
                            {whenLabel(routedMs)}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </LearningDisclosure>
            ) : null}
            {retainLensEntries.length > 0 ? (
              <LearningDisclosure
                label="Lens weights"
                count={retainLensEntries.length}
              >
                <div
                  className="pc-learning__flow"
                  aria-label="Lens sampling weights"
                >
                  <span
                    className="pc-learning__flowchip"
                    title={`${t("scout")} picks its creative lenses with these sampling weights — learned from routed-idea outcomes and grades.`}
                  >
                    <Sparkles size={11} aria-hidden />
                    the loop learns which lenses win
                  </span>
                  {retainLensEntries.map(([lens, share]) => (
                    <span
                      key={lens}
                      className="pc-learning__lens"
                      title={`${lens}: ${share}% of next cycle's lens sampling.`}
                    >
                      <em>{lens}</em>
                      <span className="pc-learning__lensbar" aria-hidden>
                        <span style={{ width: `${share}%` }} />
                      </span>
                      <strong>{share}%</strong>
                    </span>
                  ))}
                </div>
              </LearningDisclosure>
            ) : null}
            {extrasSnap.rubricChanges.length > 0 ? (
              <LearningDisclosure
                label="Rubric changes"
                count={extrasSnap.rubricChanges.length}
              >
                <ul
                  className="pc-learning__retainextras"
                  aria-label="Recently updated rubrics"
                >
                  {extrasSnap.rubricChanges.map((r) => (
                    <li key={r.slug}>
                      <Gauge size={11} aria-hidden />
                      <strong title={r.slug}>{r.title}</strong>
                      <span
                        className="pc-learning__chip"
                        title="Rubric lifecycle status"
                      >
                        {r.status}
                      </span>
                      <span className="pc-learning__age">
                        {whenLabel(Date.parse(r.updatedAt))}
                      </span>
                    </li>
                  ))}
                </ul>
              </LearningDisclosure>
            ) : null}
            {extrasSnap.insightDocs.length > 0 ? (
              <LearningDisclosure
                label="Agent insights"
                count={extrasSnap.insightDocs.length}
              >
                <ul
                  className="pc-learning__retainextras"
                  aria-label="Newest agent-insight runbooks"
                >
                  {extrasSnap.insightDocs.map((d) => (
                    <li key={d.slug}>
                      <BookOpen size={11} aria-hidden />
                      <strong title={`/internal/docs/agent-insights/${d.slug}`}>
                        {d.title}
                      </strong>
                      {d.discovered ? (
                        <span
                          className="pc-learning__age"
                          title="Discovered date from the runbook's frontmatter"
                        >
                          {d.discovered}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </LearningDisclosure>
            ) : null}
            {extrasSnap.recipes.length > 0 ? (
              <LearningDisclosure
                label="Recipes"
                count={extrasSnap.recipes.length}
              >
                <ul
                  className="pc-learning__retainextras"
                  aria-label="Most-recently-run code recipes"
                >
                  {extrasSnap.recipes.map((r) => (
                    <li key={r.id}>
                      <FlaskConical size={11} aria-hidden />
                      <strong title={r.id}>{r.title}</strong>
                      <span
                        className="pc-learning__chip"
                        title="Total recorded runs"
                      >
                        ×{r.runCount}
                      </span>
                      {r.lastRunAt ? (
                        <span className="pc-learning__age">
                          {whenLabel(Date.parse(r.lastRunAt))}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </LearningDisclosure>
            ) : null}
          </>
        ) : null}
      </section>
    </>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone?: "auto" | "human" | "good";
  hint?: string;
}) {
  return (
    <div
      className={`pc-learning__stat${tone ? ` pc-learning__stat--${tone}` : ""}`}
      title={hint}
    >
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function LearningStyles() {
  return (
    <style>{`
      .pc-learning { container: learning / inline-size; display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 8px 14px 14px; gap: 7px; overflow: hidden; }

      .pc-learning__stage-list {
        /* Auto-flow columns: every stage stays on ONE row regardless of how
           many STAGES holds (repeat(4) wrapped Retain when Analyze landed). */
        display: grid; grid-auto-flow: column; grid-auto-columns: minmax(90px, 1fr);
        align-items: start; width: 100%; max-width: 720px; margin: 0 auto; padding: 0 22px; box-sizing: border-box;
      }
      .pc-learning__stage {
        --stage-accent: var(--accent);
        position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px;
        min-width: 0; padding: 0 8px; border: 0; background: transparent;
        color: var(--fg-mute); cursor: pointer; font: inherit;
      }
      .pc-learning__stage:nth-child(2) { --stage-accent: var(--warn); }
      .pc-learning__stage:nth-child(3) { --stage-accent: var(--good); }
      .pc-learning__stage:nth-child(4) { --stage-accent: var(--accent-strong); }
      .pc-learning__stage-icon {
        position: relative; z-index: 1; display: grid; place-items: center; width: 30px; height: 30px;
        border: 1px solid var(--border-strong); border-radius: 50%; background: var(--bg-1); color: var(--fg-mute);
        transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast), box-shadow var(--dur-fast);
      }
      .pc-learning__stage-line {
        position: absolute; z-index: 0; top: 15px; left: calc(50% + 15px); width: calc(100% - 30px); height: 1px;
        background: var(--border-strong); pointer-events: none;
      }
      .pc-learning__stage-label { font-size: 11px; font-weight: 650; }
      .pc-learning__statusmark { position: absolute; right: -2px; bottom: -2px; width: 7px; height: 7px; border: 2px solid var(--bg-1); border-radius: 50%; background: var(--fg-mute); }
      .pc-learning__statusdesc { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .pc-learning__stage-icon.has-active, .pc-learning__view-icon.has-active { --learning-status: var(--accent); }
      .pc-learning__stage-icon.has-attention, .pc-learning__view-icon.has-attention { --learning-status: #fbbf24; }
      .pc-learning__stage-icon.has-failure, .pc-learning__view-icon.has-failure { --learning-status: #fb7185; }
      .pc-learning__stage-icon.has-dormant, .pc-learning__view-icon.has-dormant { --learning-status: var(--fg-mute); }
      .pc-learning__stage-icon[class*="has-"], .pc-learning__view-icon[class*="has-"] { border-color: color-mix(in srgb, var(--learning-status) 64%, var(--border)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--learning-status) 8%, transparent); }
      .pc-learning__stage-icon.has-dormant, .pc-learning__view-icon.has-dormant { border-style: dashed; box-shadow: none; opacity: .78; }
      .pc-learning__stage-icon .pc-learning__statusmark, .pc-learning__view-icon .pc-learning__statusmark { background: var(--learning-status); }
      .pc-learning__stage:hover .pc-learning__stage-icon { color: var(--fg); border-color: var(--stage-accent); background: var(--bg-2); }
      .pc-learning__stage[aria-selected="true"] { color: var(--fg); }
      .pc-learning__stage[aria-selected="true"] .pc-learning__stage-icon {
        color: var(--stage-accent); border-color: var(--stage-accent);
        background: color-mix(in oklab, var(--stage-accent), transparent 88%);
      }
      .pc-learning__controls { min-height: 30px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .pc-learning__view-tabs { min-width: 0; max-width: 100%; }
      /* Real TAB shapes (owner ask 2026-07-19: "make the tabs inside all the
         steps look more like tabs"): each view tab is a top-rounded box that
         sits ON the strip's baseline rail; the selected one adopts the panel
         background and punches a hole through the rail so it reads as
         physically connected to the content below, instead of the previous
         underline-only treatment. */
      .pc-learning__view-list { display: inline-flex; align-items: flex-end; gap: 3px; max-width: 100%; padding: 0 3px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; border-bottom: 1px solid var(--border); background: transparent; }
      .pc-learning__view-tab {
        display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; padding: 5px 11px 6px;
        border: 1px solid transparent; border-bottom: 1px solid transparent;
        border-radius: 8px 8px 0 0; margin-bottom: -1px;
        background: color-mix(in srgb, var(--fg-mute) 7%, transparent);
        color: var(--fg-mute); cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 620;
        transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
      }
      .pc-learning__view-icon { position: relative; display: grid; place-items: center; width: 18px; height: 18px; flex: none; border: 1px solid transparent; border-radius: 50%; }
      .pc-learning__view-icon .pc-learning__statusmark { right: -3px; bottom: -3px; width: 6px; height: 6px; border-width: 1.5px; }
      .pc-learning__view-tab:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 10%, transparent); }
      .pc-learning__view-tab[aria-selected="true"] {
        color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, var(--bg, transparent));
        border-color: var(--border);
        /* Erase the rail beneath the active tab — the "connected" tab look. */
        border-bottom-color: color-mix(in srgb, var(--accent) 8%, var(--bg, transparent));
        box-shadow: inset 0 2px 0 var(--accent);
      }
      /* Overflow affordance (P-007): fade the clipped edge of the view strip so
         hidden tabs read as "more this way" (background-independent CSS mask,
         -webkit- prefixed for the WebKitGTK desktop) — same pattern as
         AdvShell's top-level tab strip. */
      .pc-learning__view-tabs[data-of-left][data-of-right] .pc-learning__view-list {
        -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
        mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
      }
      .pc-learning__view-tabs[data-of-left]:not([data-of-right]) .pc-learning__view-list {
        -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px);
        mask-image: linear-gradient(90deg, transparent 0, #000 22px);
      }
      .pc-learning__view-tabs:not([data-of-left])[data-of-right] .pc-learning__view-list {
        -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent 100%);
        mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent 100%);
      }

      .pc-learning__hivepick {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 10px; font-size: 11.5px; font-weight: 600; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg-2); color: var(--fg-mute);
      }
      /* Picker moved to the row START (owner ask 2026-07-26); the health chip
         takes over the right edge so the row keeps a stable anchor there. */
      .pc-learning__controls > .pc-lihealth { margin-left: auto; }
      .pc-learning__hivepicklabel { text-transform: uppercase; font-size: 10px; letter-spacing: 0; }
      .pc-learning__body { flex: 1; min-height: 240px; overflow: hidden; }
      .pc-learning__viewpane { height: 100%; min-height: 0; overflow: auto; }
      .pc-learning__viewpane[data-view="observations"] { overflow: hidden; }
      .pc-learning__rubricsplit { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; height: 100%; min-height: 0; overflow: hidden; }
      .pc-learning__rubricsplit:has(.pc-learning__rubricdetail) { grid-template-columns: minmax(310px, .78fr) minmax(0, 1.22fr); }
      .pc-learning__rubricdetail { min-width: 0; overflow: auto; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-1); }

      .pc-learning__viewpane:not([data-view="learnings"]):not([data-view="throughput"]) .pc-learning-visual__head h2 {
        position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
      }

      @container learning (max-width: 720px) {
        .pc-learning__stage-list { padding-inline: 4px; }
        .pc-learning__stage { padding-inline: 2px; }
        .pc-learning__stage-line { left: calc(50% + 15px); width: calc(100% - 30px); }
        .pc-learning__rubricsplit:has(.pc-learning__rubricdetail) { grid-template-columns: 1fr; overflow: auto; }
        .pc-learning__rubricdetail { min-height: 420px; }
      }
      /* P-007: the former ≤1100px Verify-only icon-pill collapse (labels
         clip-path-hidden except the selected tab) is deliberately GONE — it was
         mystery-meat. Labels stay visible at every width; a crowded strip
         scrolls, with the edge-fade affordance above signalling clipped tabs. */
      @container learning (max-width: 1100px) {
        .pc-learning__view-tab { padding-inline: 7px; }
      }
      @container learning (max-width: 560px) {
        .pc-learning { padding-inline: 9px; }
        .pc-learning__stage-list { grid-auto-columns: minmax(44px, 1fr); }
        .pc-learning__stage-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .pc-learning__controls { flex-wrap: nowrap; }
        .pc-learning__view-tabs { flex: 1 1 auto; overflow: hidden; }
        .pc-learning__hivepicklabel { display: none; }
      }

      /* Release-readiness strip (learning-tab-alignment P-001) — the Verify stage's GO/NO-GO gate. */
      .pc-learning__readiness {
        display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
        padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-1);
      }
      .pc-learning__readiness-verdict {
        display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px;
        border: 1px solid transparent; border-radius: 999px;
        font-size: 10.5px; font-weight: 740; text-transform: uppercase; letter-spacing: 0;
      }
      .pc-learning__readiness-verdict em { font-style: normal; font-weight: 620; font-variant-numeric: tabular-nums; opacity: .85; }
      .pc-learning__readiness-verdict--pass { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); background: color-mix(in srgb, var(--good) 10%, transparent); }
      .pc-learning__readiness-verdict--fail { color: #fb7185; border-color: color-mix(in srgb, #fb7185 45%, transparent); background: color-mix(in srgb, #fb7185 10%, transparent); }
      .pc-learning__readiness-verdict--incomplete { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 45%, transparent); background: color-mix(in srgb, #fbbf24 10%, transparent); }
      .pc-learning__readiness-verdict--unknown { color: var(--fg-mute); border-color: var(--border); background: var(--bg-2); }
      .pc-learning__readiness-bar {
        display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
        border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2);
        font-size: 10.5px; font-weight: 620; color: var(--fg-mute); cursor: default;
      }
      .pc-learning__readiness-bar--pass svg { color: var(--good); }
      .pc-learning__readiness-bar--fail { color: var(--fg-dim); border-color: color-mix(in srgb, #fb7185 40%, var(--border)); }
      .pc-learning__readiness-bar--fail svg { color: #fb7185; }
      .pc-learning__readiness-bar--unknown svg { color: var(--fg-mute); }
      .pc-learning__readiness-rubric {
        margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
        font-size: 10.5px; font-weight: 620; color: var(--fg-mute); cursor: default;
      }
      .pc-learning__readiness-rubric--active svg { color: var(--good); }
      .pc-learning__readiness-rubric--proposed svg { color: #fbbf24; }
      @container learning (max-width: 720px) {
        .pc-learning__readiness-rubric { margin-left: 0; }
      }

      /* Flow strip (P-041) — compact in/out chips above the stock scoreboard. */
      .pc-learning__flow { display: flex; flex-wrap: wrap; gap: 6px; }
      .pc-learning__flowchip {
        display: inline-flex; align-items: center; gap: 5px;
        /* Squared chip language (owner design pass 2026-07-19) — pills are
           reserved for tiny STATUS badges, refs/metrics ride rounded rects. */
        padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__flowchip strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__flowchip em { font-style: normal; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__flowchip--link { cursor: pointer; }
      .pc-learning__flowchip--link:hover { border-color: color-mix(in srgb, var(--accent, #7dd3fc) 45%, transparent); color: var(--fg-dim, #b9d4e8); }
      .pc-learning__gradednote { margin: 2px 2px 6px; font-size: 10.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__retainextras { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__retainextras li {
        display: flex; align-items: center; gap: 7px; padding: 4px 9px;
        border-radius: 6px; font-size: 11.5px; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, rgba(125, 211, 252, 0.12));
      }
      .pc-learning__retainextras li strong { font-weight: 620; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .pc-learning__retainextras li .pc-learning__age { margin-left: auto; flex-shrink: 0; }
      .pc-learning__retainlink {
        all: unset; cursor: pointer; font-weight: 620; min-width: 0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; flex: 1; color: inherit;
      }
      .pc-learning__retainlink:hover, .pc-learning__retainlink:focus-visible { text-decoration: underline; color: var(--fg, #e7eef5); }
      .pc-learning__retainidea {
        display: inline-flex; align-items: center; gap: 3px; font-style: normal;
        color: var(--fg-faint, #7d93a6); font-size: 10.5px; max-width: 34%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1;
      }
      .pc-learning__flownet { display: inline-flex; align-items: center; gap: 1px; font-weight: 740; font-variant-numeric: tabular-nums; }
      .pc-learning__flownet--good { color: var(--good); }
      .pc-learning__flownet--warn { color: var(--warn); }
      .pc-learning__flownet--flat { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__flowchip--wd-good { border-color: rgba(52, 211, 153, 0.4); }
      .pc-learning__flowchip--wd-warn { border-color: rgba(252, 211, 77, 0.45); }
      .pc-learning__flowchip--wd-bad { border-color: rgba(248, 113, 113, 0.5); }
      .pc-learning__flowdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .pc-learning__flowdot--good { background: var(--good); box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
      .pc-learning__flowdot--warn { background: var(--warn); box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
      .pc-learning__flowdot--bad { background: var(--bad); box-shadow: 0 0 5px rgba(248, 113, 113, 0.6); }

      /* Cadence card (learning-tab-visibility P-001) — live volume-gate state:
         score bar vs threshold + per-lane pending-signal chips. */
      .pc-learning__cadence {
        display: flex; flex-direction: column; gap: 5px; padding: 7px 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 8px;
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-learning__cadence-head {
        display: inline-flex; align-items: center; gap: 8px; font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__cadence-head strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-learning__cadence-head em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__cadence-bar {
        flex: 0 1 140px; min-width: 60px; height: 5px; border-radius: 999px;
        background: color-mix(in srgb, var(--fg-mute, #7f9bb4) 18%, transparent); overflow: hidden;
      }
      .pc-learning__cadence-fill { display: block; height: 100%; border-radius: 999px; background: var(--accent); transition: width 300ms ease; }
      .pc-learning__cadence-fill--armed { background: var(--good, #34d399); }
      .pc-learning__cadence-lanes { display: flex; flex-wrap: wrap; gap: 4px; }

      /* Drafts-in-iteration list (learning-tab-visibility P-005). */
      .pc-learning__draftlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
      .pc-learning__draftrow {
        display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px;
        color: var(--fg-dim, #b9d4e8); padding: 2px 2px;
      }
      .pc-learning__draftrow strong { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }
      .pc-learning__draftrow em { font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__draftwhen { font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }

      /* Tick-economics strip (learning-tab-alignment P-002) — one cell per scout
         tick: when · gen→routed funnel · stop reason · spend · lens chips. */
      .pc-learning__tickstrip { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }
      .pc-learning__tick {
        display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
        padding: 3px 7px; font-size: 10.5px; font-weight: 600; border-radius: 7px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
        cursor: default; white-space: nowrap;
      }
      .pc-learning__tick em { font-style: normal; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-learning__tick strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__tickstop { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
      .pc-learning__tickspend { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-learning__ticklens {
        font-style: normal; font-size: 9px; font-weight: 700; padding: 1px 5px;
        border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
        color: var(--accent-strong, var(--accent)); background: color-mix(in srgb, var(--accent) 10%, transparent);
      }
      .pc-learning__tick--good { border-color: rgba(52, 211, 153, 0.4); }
      .pc-learning__tick--good strong { color: #86efac; }
      .pc-learning__tick--warn { border-color: color-mix(in srgb, #fbbf24 45%, transparent); background: color-mix(in srgb, #fbbf24 7%, transparent); }
      .pc-learning__tick--warn strong { color: #fbbf24; }
      .pc-learning__tick--bad { border-color: color-mix(in srgb, #fb7185 50%, transparent); background: color-mix(in srgb, #fb7185 7%, transparent); }
      .pc-learning__tick--bad strong { color: #fb7185; }
      .pc-learning__tick--idle { opacity: 0.75; }

      /* P-004 pipeline trace: the idea's loop as one row of stages. Spans the
         scout row's grid; stages wrap on narrow panes (the arrows ride along). */
      /* The pipeline trace as a clean label/value grid (owner ask 2026-07-19:
         "the whole design needs a lot of work") — one aligned row per stage,
         no arrow soup, labels in a fixed column so five stages scan as a card
         ledger in the stacked-card width. */
      .pc-learning__trace {
        grid-column: 1 / -1;
        display: grid; grid-template-columns: max-content minmax(0, 1fr);
        gap: 7px 12px; align-items: start;
        margin-top: 9px; padding: 10px 12px; border-radius: 9px;
        background: color-mix(in srgb, var(--bg-1, #0d151d) 60%, transparent);
      }
      .pc-learning__tracerow { display: contents; }
      .pc-learning__tracerow > em {
        font-style: normal; font-size: 8.5px; font-weight: 720; text-transform: uppercase;
        letter-spacing: 0; color: var(--fg-mute, #7f9bb4); padding-top: 3px; white-space: nowrap;
      }
      .pc-learning__tracerow > strong {
        font-size: 11px; font-weight: 620; color: var(--fg-dim, #b9d4e8);
        min-width: 0; overflow-wrap: anywhere;
      }
      .pc-learning__tracerow > strong i { font-style: normal; font-size: 9.5px; font-weight: 600; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__tracerow.is-missing > strong { color: var(--fg-mute, #7f9bb4); font-weight: 520; font-style: italic; }
      .pc-learning__tracerow.is-good > strong { color: #86efac; }
      .pc-learning__tracerow.is-bad > strong { color: #fb7185; }
      .pc-learning__tracechips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
      .pc-learning__tracechips > strong {
        font-size: 11px; font-weight: 520; font-style: italic; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__tracedot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      .pc-learning__tracechip-text {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .pc-learning__tracechip b { font-weight: 680; color: var(--fg, #e7eef5); overflow: hidden; text-overflow: ellipsis; }
      .pc-learning__tracechip {
        display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 8px;
        font-size: 10.5px; font-weight: 600; border-radius: 6px; font-family: inherit;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); color: var(--fg-dim, #b9d4e8);
        /* FIXED width + end-ellipsis (owner ask 2026-07-19e): the raw id/slug
           is never needed in full on the card — the tooltip and the artifact
           itself carry it. The child -text span does the truncating. */
        max-width: 200px; white-space: nowrap; text-align: left;
        transition: border-color 130ms ease, color 130ms ease, background 130ms ease;
      }
      .pc-learning__tracechip i {
        font-style: normal; font-size: 8.5px; font-weight: 720; text-transform: uppercase;
        letter-spacing: 0; color: var(--fg-mute, #7f9bb4); flex-shrink: 0;
      }
      .pc-learning__tracechip--link { cursor: pointer; }
      .pc-learning__tracechip--link:hover, .pc-learning__tracechip--link:focus-visible {
        border-color: var(--accent, rgba(125, 211, 252, 0.45)); color: var(--accent, #7dd3fc);
      }

      .pc-learning__scoreboard { display: flex; flex-wrap: wrap; gap: 8px; }
      .pc-learning__throughputhive { display: flex; flex-direction: column; gap: 8px; padding-bottom: 12px; }
      .pc-learning__throughputhive + .pc-learning__throughputhive { border-top: 1px solid var(--border, rgba(125, 211, 252, 0.12)); padding-top: 12px; }
      .pc-learning__stat {
        display: flex; flex-direction: column; gap: 2px; min-width: 96px;
        padding: 9px 13px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
      }
      .pc-learning__stat strong { font-size: 20px; font-weight: 760; line-height: 1; color: var(--fg, #e7f7ff); font-variant-numeric: tabular-nums; }
      .pc-learning__stat span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__stat--auto strong { color: #86efac; }
      .pc-learning__stat--human strong { color: #fcd34d; }
      .pc-learning__stat--good strong { color: var(--accent-strong, var(--accent)); }

      .pc-learning__section { display: flex; flex-direction: column; gap: 7px; }
      .pc-learning__sectionhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .pc-learning__sectionhead--tools { justify-content: flex-start; min-height: 28px; }
      /* Pin the runs header inside the scrolling view-pane so the newest-run
         recency stays on screen while the user scrolls down to the judge cards
         (owner escalation 2026-07-26: scrolling hid every recent run and the
         list appeared to start hours ago). Opaque background + z-index so rows
         slide UNDER it rather than through it. */
      .pc-learning__sectionhead--stickyruns {
        position: sticky; top: 0; z-index: 3;
        background: var(--bg, #07101d); padding: 4px 0 5px;
        box-shadow: 0 6px 10px -8px rgba(0,0,0,0.85);
      }
      /* Challenger cards as a GRID, newest first (owner ask 2026-07-27) — replaces
         the per-role 1-of-N CardStack carousel so the list IS the overview. Wide
         panes get columns; a narrow dock pane collapses to one column via the
         container query below. */
      .pc-learning__gymcardgrid {
        display: grid; gap: 8px; margin-top: 6px;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        align-items: start;
      }
      .pc-learning__gymcard {
        min-width: 0; border-left: 3px solid var(--border, #2a2a2a);
        border-radius: 8px; background: var(--bg-1, #0b1220);
      }
      /* Per-role challenger groups (owner ask 2026-07-27) — the stacks the
         CardStack decks used to give, but collapsible instead of 1-of-N. */
      .pc-learning__gymrolegroup { margin-top: 8px; min-width: 0; }
      .pc-learning__gymrolehead {
        display: flex; align-items: center; gap: 8px; width: 100%;
        padding: 4px 8px; border: 0; border-left: 3px solid var(--border, #2a2a2a);
        border-radius: 6px; background: var(--bg-2, #0b1220);
        color: var(--fg, #e7f7ff); cursor: pointer; text-align: left;
      }
      .pc-learning__gymrolehead:hover { background: var(--bg-3, #101a28); }
      .pc-learning__gymrolename {
        font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
      }
      .pc-learning__gymcard .pc-learning__gymprompt {
        max-height: 148px; overflow: auto;
      }
      @container learning (max-width: 560px) {
        .pc-learning__gymcardgrid { grid-template-columns: minmax(0, 1fr); }
      }
      .pc-learning__runsrecency {
        font-size: 11px; font-weight: 600; color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, #2a2a2a); border-radius: 999px;
        padding: 1px 8px; white-space: nowrap;
      }
      .pc-learning__sectionhead h2 { margin: 0; font-size: 13px; font-weight: 740; text-transform: uppercase; letter-spacing: 0; color: var(--fg, #e7eef5); }
      .pc-learning__inlinetools { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      /* Work-Queue-parity search + filter affordances (owner ask 2026-07-19). */
      .pc-learning__search {
        display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 999px;
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__search:focus-within {
        border-color: color-mix(in srgb, var(--accent, #7dd3fc) 48%, var(--border));
        color: var(--fg, #e7eef5);
      }
      .pc-learning__search input {
        border: 0; background: none; outline: none; color: var(--fg, #e7eef5);
        font: inherit; font-size: 11px; width: 150px;
      }
      .pc-learning__search input::placeholder { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__matchcount {
        font-size: 11px; color: var(--fg-mute, #7f9bb4);
        font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .pc-learning__lanes { display: inline-flex; gap: 4px; }
      .pc-learning__lane {
        padding: 4px 10px; font-size: 11px; font-weight: 650; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: transparent; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__lane.is-active { color: var(--fg, #e7f7ff); border-color: rgba(var(--accent-strong-rgb, 125, 211, 252), 0.5); background: rgba(var(--accent-strong-rgb, 125, 211, 252), 0.12); }
      .pc-learning__refresh {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; flex-shrink: 0;
        border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
        border-radius: 8px; background: var(--bg-popover, #0d1829); color: var(--fg-dim, #b9d4e8); cursor: pointer;
      }
      .pc-learning__refresh:disabled { opacity: 0.5; cursor: default; }

      .pc-learning__loops { display: flex; flex-wrap: wrap; gap: 6px; }
      .pc-learning__loop {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 9px; font-size: 11px; font-weight: 600; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__loop em { font-style: normal; text-transform: uppercase; font-size: 9.5px; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__loop--running { border-color: rgba(52, 211, 153, 0.5); }
      .pc-learning__loop--running em { color: #86efac; }
      .pc-learning__loopspend { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: var(--fg-mute, #7f9bb4); }

      .pc-learning__scopenote {
        margin: 0 0 8px; padding: 6px 10px; border-radius: 8px; font-size: 11px;
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.25)); background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }

      .pc-learning__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__row {
        display: grid; grid-template-columns: 4px auto 1fr auto; align-items: center; gap: 9px;
        padding: 6px 9px; border-radius: 8px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.13));
        background: var(--bg-2, rgba(255, 255, 255, 0.03));
      }
      .pc-learning__sev { width: 4px; height: 100%; min-height: 18px; border-radius: 3px; }
      .pc-learning__row--link { cursor: pointer; }
      .pc-learning__row--selected { border-color: #f59e0b; box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.35); cursor: pointer; }
      .pc-learning__row--link:hover, .pc-learning__row--link:focus-visible { border-color: var(--accent, rgba(125, 211, 252, 0.45)); background: var(--bg-3, rgba(255, 255, 255, 0.06)); }
      .pc-learning__id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__title { font-size: 12.5px; color: var(--fg, #e7f7ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__muted { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__meta { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .pc-learning__chip {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 7px; font-size: 10px; font-weight: 600; text-transform: lowercase;
        border-radius: 999px; border: 1px solid currentColor; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__chip--idea { color: #a78bfa; border-color: rgba(167, 139, 250, 0.5); }
      /* Pipeline stage (P-004). The ramp reads as progress — inert grey while
         the loop has only had the idea, cool blue once it is queued work, warm
         amber while an agent is on it, green when it lands. Colour is redundant
         with the chip's own text, never the sole carrier of the state.
         (--auto/--human were removed with the approval chip they styled.) */
      .pc-learning__chip--stage-not-ready { color: #94a3b8; border-color: rgba(148, 163, 184, 0.45); }
      .pc-learning__chip--stage-approved { color: var(--accent, #7dd3fc); border-color: var(--accent, rgba(125, 211, 252, 0.5)); }
      .pc-learning__chip--stage-in-flight { color: #fcd34d; border-color: rgba(252, 211, 77, 0.5); }
      .pc-learning__chip--stage-shipped { color: #86efac; border-color: rgba(134, 239, 172, 0.5); }
      .pc-learning__chip--stage-dropped { color: #94a3b8; border-color: rgba(148, 163, 184, 0.35); text-decoration: line-through; }
      .pc-learning__delta { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .pc-learning__delta--good { color: var(--good); }
      .pc-learning__delta--bad { color: var(--bad); }
      .pc-learning__delta--flat { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__age { font-size: 11px; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__score { font-size: 11px; font-weight: 700; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; min-width: 18px; text-align: right; }

      /* Scout grading (B-07, scout-idea-grading-2026-06-12): the routed-idea row
         splits into a clickable main area + a grade cluster, so stars/note/chip
         never fight the open-the-artifact click. */
      .pc-learning__row--scout { grid-template-columns: minmax(0, 1fr) auto; }
      .pc-learning__row--scout .pc-learning__meta { flex-wrap: wrap; justify-content: flex-end; }
      .pc-learning__rowmain { width: 100%; display: grid; grid-template-columns: 4px auto minmax(0, 1fr); align-items: center; gap: 9px; min-width: 0; padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
      .pc-learning__rowmain:hover .pc-learning__title, .pc-learning__rowmain:focus-visible .pc-learning__title { color: var(--accent, #7dd3fc); }
      .pc-learning__grade { display: inline-flex; align-items: center; gap: 5px; }
      .pc-learning__stars { display: inline-flex; }
      .pc-learning__star { display: inline-flex; align-items: center; padding: 1px; background: none; border: none; border-radius: 3px; color: var(--fg-mute, #7f9bb4); cursor: pointer; }
      .pc-learning__star.is-on { color: #fbbf24; }
      .pc-learning__star:hover { color: #fcd34d; }
      .pc-learning__star:disabled { opacity: 0.5; cursor: default; }
      .pc-learning__gradechip { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; font-size: 10px; font-weight: 700; border-radius: 999px; border: 1px solid rgba(251, 191, 36, 0.5); color: #fbbf24; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-learning__notebtn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: none; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); border-radius: 6px; color: var(--fg-mute, #7f9bb4); cursor: pointer; }
      .pc-learning__notebtn:hover { color: var(--fg-dim, #b9d4e8); border-color: var(--border-strong, rgba(125, 211, 252, 0.32)); }
      .pc-learning__gradepanel { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 7px; margin-top: 7px; padding-top: 9px; border-top: 1px dashed var(--border, rgba(125, 211, 252, 0.2)); cursor: default; }
      .pc-learning__gradepanelrow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
      .pc-learning__gradecancel { margin-left: auto; }
      .pc-learning__gradepanelhint { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__gradepanel textarea { background: var(--bg-2, rgba(255, 255, 255, 0.03)); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); border-radius: 7px; color: var(--fg, #e7f7ff); font-size: 12px; font-family: inherit; line-height: 1.45; padding: 6px 9px; resize: vertical; }
      .pc-learning__gradepanelactions { display: flex; justify-content: flex-end; gap: 8px; }
      .pc-learning__gradepopover { width: min(430px, calc(100vw - 28px)); padding: 10px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-popover); box-shadow: 0 14px 40px rgba(0,0,0,.42); }
      .pc-learning__gradepopover .pc-learning__gradepanel { margin: 0; padding: 0; border: 0; }
      .pc-learning__panelbtn { padding: 4px 11px; font-size: 11.5px; font-weight: 650; border-radius: 7px; cursor: pointer; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); background: transparent; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__panelbtn--primary { border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); color: #fcd34d; }
      .pc-learning__panelbtn:disabled { opacity: 0.5; cursor: default; }
      /* Ungraded ideas as per-lens overlapping stacks (owner ask 2026-07-19). */
      /* Section headers that carry their explanation inline (owner ask
         2026-07-19): title + a small readable line NEXT to it, never a
         standing block of copy. */
      .pc-learning__sectionhead--desc { justify-content: flex-start; align-items: baseline; }
      .pc-learning__sectionsub {
        flex: 1 1 auto; min-width: 0;
        font-size: 11.5px; line-height: 1.45; color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__gymhow { margin: -2px 2px 6px; }
      .pc-learning__gymtitle {
        font-size: 13px; font-weight: 660; line-height: 1.42;
        color: var(--fg, #e7eef5); overflow-wrap: anywhere;
      }
      .pc-learning__gymdeltas { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .pc-learning__gymprompt {
        margin: 2px 0 0; padding: 8px 10px; border-radius: 8px;
        font-family: ui-monospace, monospace; font-size: 10px; line-height: 1.5;
        color: var(--fg-dim, #b9d4e8);
        background: color-mix(in srgb, var(--bg-1, #0d151d) 60%, transparent);
        white-space: pre-wrap; overflow-wrap: anywhere;
        display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden;
      }
      /* ── Inline star grader on the idea card (owner ask 2026-07-19d) ───── */
      .pc-learning__stargrade {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 6px;
        padding: 6px 9px; border-radius: 8px;
        border: 1px solid color-mix(in srgb, #fbbf24 22%, var(--border, rgba(125, 211, 252, 0.16)));
        background: color-mix(in srgb, #fbbf24 5%, transparent);
      }
      .pc-learning__stargrade.is-graded {
        border-color: color-mix(in srgb, #fbbf24 40%, transparent);
        background: color-mix(in srgb, #fbbf24 8%, transparent);
      }
      .pc-learning__stars { display: inline-flex; gap: 2px; }
      .pc-learning__star {
        display: inline-flex; padding: 2px; border: 0; background: none; cursor: pointer;
        color: color-mix(in srgb, var(--fg-mute, #7f9bb4) 65%, transparent);
        transition: color 120ms ease, transform 120ms ease;
      }
      .pc-learning__star:hover { transform: scale(1.2); color: #fbbf24; }
      .pc-learning__star.is-on { color: #fbbf24; }
      .pc-learning__star:disabled { opacity: 0.5; cursor: default; }
      .pc-learning__starmeta {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 10.5px; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums;
      }
      .pc-learning__stargrade.is-ungraded .pc-learning__starmeta { color: var(--fg-mute, #7f9bb4); font-style: italic; }
      .pc-learning__starnote {
        flex: none; padding: 2px 9px; border-radius: 6px; cursor: pointer;
        font: inherit; font-size: 10px; font-weight: 600;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: none; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__starnote:hover { color: var(--fg-dim, #b9d4e8); border-color: color-mix(in srgb, #fbbf24 45%, var(--border)); }
      .pc-learning__stargrade-note { display: flex; gap: 6px; width: 100%; }
      .pc-learning__stargrade-note input {
        flex: 1 1 auto; min-width: 0; padding: 4px 9px; border-radius: 6px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.2));
        background: var(--bg-1, #0d151d); color: var(--fg, #e7eef5); font: inherit; font-size: 11px;
      }
      .pc-learning__stargrade-note button {
        padding: 4px 12px; border-radius: 6px; cursor: pointer; font: inherit;
        font-size: 11px; font-weight: 700;
        border: 1px solid color-mix(in srgb, #fbbf24 50%, transparent);
        background: color-mix(in srgb, #fbbf24 14%, transparent); color: #fbbf24;
      }
      .pc-learning__stargrade-note button:disabled { opacity: 0.4; cursor: default; }
      /* Outcome chips: won/lost unmistakably green/red (owner ask 2026-07-19d). */
      .pc-learning__score--won {
        min-width: 0; padding: 1px 9px; border-radius: 6px; text-align: center;
        color: #052e1b; background: var(--good, #34d399); font-weight: 760;
      }
      .pc-learning__score--lost {
        min-width: 0; padding: 1px 9px; border-radius: 6px; text-align: center;
        color: #fff; background: #ef4444; font-weight: 760;
      }
      /* Plain-sentence loop warnings. */
      .pc-learning__warnlist { list-style: none; margin: 2px 0 6px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__warnlist li {
        display: flex; align-items: baseline; gap: 7px;
        font-size: 11.5px; line-height: 1.45; color: var(--fg-dim, #b9d4e8);
        padding: 6px 10px; border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--warn, #fbbf24) 30%, transparent);
        background: color-mix(in srgb, var(--warn, #fbbf24) 6%, transparent);
      }
      .pc-learning__warnlist li.is-bad {
        border-color: color-mix(in srgb, #ef4444 40%, transparent);
        background: color-mix(in srgb, #ef4444 7%, transparent);
      }
      .pc-learning__warnlist li svg { flex: none; align-self: center; color: var(--warn, #fbbf24); }
      .pc-learning__warnlist li.is-bad svg { color: #ef4444; }
      /* Readable per-run rows (replaces the tick chip soup). */
      .pc-learning__tickstrip--rows { display: flex; flex-direction: column; gap: 3px; max-height: 260px; overflow-y: auto; }
      .pc-learning__tickrow {
        display: flex; align-items: baseline; gap: 9px;
        padding: 4px 9px; border-radius: 7px; font-size: 11px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.1));
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__tickrow em { flex: none; width: 52px; font-style: normal; font-size: 10px; color: var(--fg-mute, #7f9bb4); font-variant-numeric: tabular-nums; }
      .pc-learning__tickrow strong { flex: none; width: 38px; font-weight: 720; font-variant-numeric: tabular-nums; color: var(--fg, #e7eef5); }
      .pc-learning__tickrow--warn strong { color: var(--warn, #fbbf24); }
      .pc-learning__tickrow--bad strong { color: #ef4444; }
      .pc-learning__tickwhat { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__tickrow .pc-learning__tickspend { flex: none; font-variant-numeric: tabular-nums; color: var(--fg-mute, #7f9bb4); }
      /* The idea→work funnel: stage tiles, big numbers, arrows between
         (owner ask 2026-07-19e — leads the cycle-engine section). */
      .pc-learning__funnel {
        display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap;
        margin: 2px 0 10px;
      }
      .pc-learning__funnel > span {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; min-width: 86px; padding: 9px 14px; border-radius: 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-learning__funnel > span > strong {
        font-size: 17px; font-weight: 760; line-height: 1;
        color: var(--fg, #e7eef5); font-variant-numeric: tabular-nums;
      }
      .pc-learning__funnel > span > small {
        font-size: 9.5px; font-weight: 700; text-transform: uppercase;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__funnel > span.is-good {
        border-color: color-mix(in srgb, var(--good, #34d399) 45%, transparent);
        background: color-mix(in srgb, var(--good, #34d399) 8%, transparent);
      }
      .pc-learning__funnel > span.is-good > strong { color: var(--good, #34d399); }
      .pc-learning__funnel > i {
        align-self: center; font-style: normal; font-size: 14px;
        color: var(--fg-mute, #7f9bb4);
      }
      /* The one-line plain-language glance replacing the instrument stack
         (owner ask 2026-07-19). */
      .pc-learning__glance {
        display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px;
        margin: 2px 2px 4px; font-size: 12px; color: var(--fg-dim, #b9d4e8);
      }
      .pc-learning__glance > span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
      .pc-learning__glance > span + span::before { content: "·"; margin-right: 10px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__glance strong { font-weight: 700; color: var(--fg, #e7eef5); font-variant-numeric: tabular-nums; }
      .pc-learning__glance .is-warn { color: var(--warn, #fbbf24); font-weight: 600; }
      .pc-learning__lensstacks {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px; margin-top: 8px;
      }
      /* The lens label + count render as CardStack's on-card header badge
         (pc-cardstack__header-*), so the group carries no separate head row. */
      .pc-learning__lensgroup { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      /* Card content hierarchy (owner ask 2026-07-19, continued polish):
         quiet meta row up top, the TITLE as the loudest element, the trace
         ledger recessed below — readable at a glance, roomy, consistent. */
      .pc-learning__ideacard {
        display: flex; flex-direction: column; gap: 8px;
        padding: 0 14px 13px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      /* Graded cards read at deck distance (design pass 2026-07-19g): a green
         check badge rides the band's right corner. */
      .pc-learning__ideacard { position: relative; }
      .pc-learning__ideacard.is-graded::after {
        content: "✓"; position: absolute; top: 6px; right: 8px;
        display: flex; align-items: center; justify-content: center;
        width: 16px; height: 16px; border-radius: 50%;
        font-size: 11px; font-weight: 800; line-height: 1;
        color: #052e1b; background: var(--good, #34d399);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
        pointer-events: none;
      }
      /* Accent header BAND (design pass 2026-07-19f): the category color (the
         deck's --cs-accent, cascading in) structures the card's top — meta on
         a tinted strip, content below a hairline. */
      .pc-learning__ideacard-head {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 22px;
        margin: 0 -14px 2px; padding: 9px 14px 8px;
        background: linear-gradient(
          color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 10%, transparent),
          color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 3%, transparent));
        border-bottom: 1px solid color-mix(in srgb, var(--cs-accent, var(--accent, #7dd3fc)) 16%, var(--border, rgba(125, 211, 252, 0.16)));
      }
      .pc-learning__ideacard-head .pc-learning__id {
        display: inline-flex; align-items: center; gap: 5px;
        font-size: 9.5px; font-weight: 720; text-transform: uppercase;
        opacity: 0.9;
      }
      .pc-learning__ideacard-head .pc-learning__sev {
        width: 7px; height: 7px; min-height: 0; border-radius: 50%;
      }
      .pc-learning__ideacard-head .pc-learning__age { font-size: 10px; opacity: 0.85; margin-right: 14px; }
      .pc-learning__ideacard-head .pc-learning__grade { margin-left: auto; }
      .pc-learning__ideacard-title {
        text-align: left; font: inherit; font-size: 13px; font-weight: 660; line-height: 1.42;
        color: var(--fg, #e7eef5); background: none; border: 0; padding: 0; cursor: pointer;
      }
      .pc-learning__ideacard-title:hover { color: var(--accent, #7dd3fc); }

      .pc-learning__row--retained { grid-template-columns: 4px minmax(0, 1fr) auto; }
      .pc-learning__row--retained.is-selected { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
      .pc-learning__retainedmain { width: 100%; min-width: 0; padding: 0; border: 0; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
      .pc-learning__retainedmain:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
      .pc-learning__retainedtext { display: -webkit-box; overflow: hidden; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
      .pc-learning__retainedtext.is-expanded { display: block; overflow: visible; -webkit-line-clamp: unset; }
      .pc-learning__retainedsummary { display: grid; gap: 2px; min-width: 0; }
      .pc-learning__retainedsummary > strong, .pc-learning__retainedsummary > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning__retainedsummary > strong { color: var(--fg); font-size: 11.5px; font-weight: 680; }
      .pc-learning__retainedsummary > span { color: var(--fg-mute); font-size: 10.5px; }
      .pc-learning__retainedactions { display: inline-flex; gap: 5px; margin-top: 1px; }
      .pc-learning__retainlayout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: start; }
      .pc-learning__retainlayout.has-detail { grid-template-columns: minmax(320px, .9fr) minmax(360px, 1.1fr); }
      .pc-learning__retainindex { min-width: 0; }
      .pc-learning__retaindetail { min-width: 0; padding: 10px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 9px; background: var(--bg-2); }
      .pc-learning__retaindetail > header { display: flex; align-items: center; justify-content: space-between; min-height: 24px; }
      .pc-learning__retaindetail > header button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--fg-mute); cursor: pointer; }
      .pc-learning__retaindetail > p { margin: 7px 0 10px; color: var(--fg); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
      .pc-learning__retaindetail > footer { display: flex; justify-content: flex-end; gap: 5px; }
      .pc-learning__retaincontrols { display: flex; align-items: center; gap: 4px; }
      .pc-learning__retaincontrols input { width: min(220px, 28vw); height: 26px; padding: 3px 8px; font-size: 10.5px; }
      @container learning (max-width: 820px) { .pc-learning__retainlayout.has-detail { grid-template-columns: 1fr; } .pc-learning__retaindetail { grid-row: 1; } }

      /* Lens sampling weights (P-007 steering visibility). */
      .pc-learning__lens { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4); }
      .pc-learning__lens em { font-style: normal; color: var(--fg-dim, #b9d4e8); }
      .pc-learning__lens strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__lensbar { width: 44px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
      .pc-learning__lensbar span { display: block; height: 100%; border-radius: 2px; background: #a78bfa; }

      /* P-009 first-run: the visible view gloss + the once-per-workspace orientation banner. */
      .pc-learning__strap { margin: 2px 0 0; color: var(--fg-mute, #7f9bb4); font-size: 11px; line-height: 1.4; }
      .pc-learning__orient { display: flex; align-items: flex-start; gap: 10px; margin-top: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--accent) 7%, transparent); }
      .pc-learning__orientbody { display: flex; flex-direction: column; gap: 4px; }
      .pc-learning__orientbody strong { color: var(--fg-dim, #b9d4e8); font-size: 12px; }
      .pc-learning__orientbody p { margin: 0; max-width: 72ch; color: var(--fg-mute, #7f9bb4); font-size: 11px; line-height: 1.5; }
      .pc-learning__orientaction { align-self: flex-start; margin-top: 4px; display: inline-flex; align-items: center; min-height: 25px; padding: 3px 11px; border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border)); border-radius: 7px; background: color-mix(in srgb, var(--accent) 12%, var(--bg-2)); color: var(--accent); cursor: pointer; font: inherit; font-size: 11px; font-weight: 650; }
      .pc-learning__orientaction:hover { background: color-mix(in srgb, var(--accent) 20%, var(--bg-2)); }
      .pc-learning__orientaction:focus-visible, .pc-learning__orientdismiss:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .pc-learning__orientdismiss { margin-left: auto; display: grid; place-items: center; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--fg-mute, #7f9bb4); cursor: pointer; font-size: 12px; }
      .pc-learning__orientdismiss:hover { color: var(--fg, #e6f1fa); background: var(--bg-2); }
      .pc-learning__empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 16px 12px; color: var(--fg-mute, #7f9bb4); font-size: 12px; }
      .pc-learning__empty--card { border: 1px dashed var(--border, rgba(125, 211, 252, 0.2)); border-radius: 12px; }
      .pc-learning__empty strong { color: var(--fg-dim, #b9d4e8); font-size: 13px; }
      .pc-learning__empty span { max-width: 58ch; }
      .pc-learning__quietempty { min-height: 34px; display: flex; align-items: center; justify-content: center; gap: 7px; margin: 0; border: 1px dashed color-mix(in srgb, var(--border) 70%, transparent); border-radius: 8px; color: var(--fg-mute); font-size: 11px; }
      .pc-learning__packtools { flex-wrap: wrap; padding: 3px 0 6px; }

      /* Benchmark (apiary) trend rows + knowledge cross-link. */
      .pc-learning__benchcell { display: inline-flex; align-items: baseline; gap: 9px; min-width: 0; overflow: hidden; }
      .pc-learning__benchnum { font-size: 14px; font-weight: 760; color: var(--fg, #e7f7ff); font-variant-numeric: tabular-nums; }
      .pc-learning__benchmeta { font-size: 11px; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__knowledge { align-items: flex-start; text-align: left; }
      .pc-learning__knowledge strong { font-size: 14px; }
      .pc-learning__cta {
        display: inline-flex; align-items: center; gap: 6px; margin-top: 4px;
        padding: 7px 13px; font-size: 12px; font-weight: 650; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.14); color: #86efac;
      }
      .pc-learning__cta:hover { background: rgba(52, 211, 153, 0.24); color: #e7f7ff; }

      .pc-learning__footnote { margin: 2px 0 0; font-size: 11px; font-style: italic; color: var(--fg-mute, #7f9bb4); }

      .pc-learning__gymflow, .pc-learning__improvementflow, .pc-learning__memorymap {
        min-height: 120px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-2);
      }
      .pc-learning__gymflow { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 7px; padding: 12px; }
      .pc-learning__gymflow > span { position: relative; display: grid; place-content: center; justify-items: center; min-height: 62px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-1); }
      .pc-learning__gymflow small, .pc-learning__improvementflow small { color: var(--fg-mute); font-size: 9px; font-weight: 700; text-transform: uppercase; }
      .pc-learning__gymflow strong, .pc-learning__improvementflow strong { margin-top: 4px; color: var(--fg); font-size: 23px; font-variant-numeric: tabular-nums; }
      .pc-learning__gymflow > span.is-good strong, .pc-learning__improvementflow > span.is-good strong { color: #34d399; }
      .pc-learning__gymflow > span.is-warn strong, .pc-learning__improvementflow > span.is-human strong { color: #fbbf24; }
      .pc-learning__gymflow > span.is-accent strong, .pc-learning__improvementflow > span.is-auto strong { color: var(--accent); }
      .pc-learning__gymflow > span > i { position: absolute; top: 50%; left: calc(100% + 1px); width: 9px; height: 1px; background: var(--border-strong); }
      .pc-learning__improvementflow { display: grid; grid-template-columns: 1fr auto 1fr 1fr auto 1fr; align-items: center; gap: 7px; padding: 12px; }
      .pc-learning__improvementflow > span { display: grid; place-content: center; justify-items: center; min-height: 56px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 4%, transparent); }
      .pc-learning__improvementflow > i { width: 18px; height: 1px; background: var(--border-strong); }
      .pc-learning__lanegrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start; }
      .pc-learning__lanegrid.is-single { grid-template-columns: minmax(0, 1fr); }
      .pc-learning__lanecol { min-width: 0; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--bg-2) 88%, transparent); overflow: hidden; }
      .pc-learning__lanecol > header { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; border-bottom: 1px solid var(--border); color: var(--fg-mute); font-size: 10px; font-weight: 750; text-transform: uppercase; }
      .pc-learning__lanecol.is-auto > header strong { color: var(--accent); }
      .pc-learning__lanecol.is-human > header strong { color: #fbbf24; }
      .pc-learning__lanecol > .pc-learning__list { padding: 6px; }
      .pc-learning__lanecol .pc-learning__row { grid-template-columns: 4px auto minmax(0, 1fr); }
      .pc-learning__lanecol .pc-learning__meta { grid-column: 2 / -1; justify-content: flex-end; }
      .pc-learning__idea-filters { display: flex; align-items: center; gap: 5px; overflow-x: auto; padding: 2px 0; }
      .pc-learning__idea-filters button { display: inline-flex; align-items: center; gap: 5px; flex: none; min-height: 27px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--fg-mute); font: inherit; font-size: 10px; cursor: pointer; }
      .pc-learning__idea-filters button:hover, .pc-learning__idea-filters button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); background: color-mix(in srgb, var(--accent) 8%, var(--bg-2)); color: var(--fg); }
      .pc-learning__idea-filters button > i { width: 6px; height: 6px; border-radius: 50%; }
      .pc-learning__idea-filters strong { color: var(--fg); font-size: 10px; font-variant-numeric: tabular-nums; }
      .pc-learning__pendingrun { display: flex; align-items: center; gap: 7px; min-height: 30px; padding: 5px 9px; border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--accent) 6%, transparent); color: var(--fg-mute); font-size: 10.5px; }
      .pc-learning__pendingrun svg { color: var(--accent); }
      .pc-learning__pendingrun strong { color: var(--fg); font-family: var(--font-mono, ui-monospace, monospace); }
      .pc-learning__pendingrun em { margin-left: auto; color: var(--fg-mute); font-style: normal; font-variant-numeric: tabular-nums; }
      .pc-learning__pendinginline { display: inline-flex; align-items: center; gap: 4px; margin-left: 7px; padding-left: 7px; border-left: 1px solid var(--border); color: var(--accent); font-size: 9px; font-variant-numeric: tabular-nums; }
      .pc-learning__provenance { display: inline-grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 50%; color: var(--fg-mute); }
      .pc-learning__provenance.is-owner { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
      .pc-learning__provenance.is-brain { color: #34d399; border-color: color-mix(in srgb, #34d399 42%, var(--border)); }
      .pc-learning__provenance.is-scout { color: #a78bfa; border-color: color-mix(in srgb, #a78bfa 42%, var(--border)); }
      .pc-learning__provenance.is-system { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 42%, var(--border)); }
      .pc-learning__provenance.is-reference { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
      .pc-learning__memorymap { display: grid; grid-template-columns: repeat(16, minmax(5px, 1fr)); grid-auto-rows: 1fr; gap: 3px; padding: 12px; }
      .pc-learning__memorymap i { min-height: 10px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 58%, transparent); opacity: .78; }
      .pc-learning__memorymap i.is-organic { background: #34d399; }
      .pc-learning__memorymap i:hover { opacity: 1; transform: scale(1.08); }
      .pc-learning__standings { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; font-size: 9px; }
      @container learning (max-width: 920px) { .pc-learning__lanegrid { grid-template-columns: 1fr; } }
      @container learning (max-width: 720px) { .pc-learning__gymflow, .pc-learning__improvementflow { grid-template-columns: 1fr; } .pc-learning__gymflow > span > i, .pc-learning__improvementflow > i { display: none; } }
    `}</style>
  );
}
