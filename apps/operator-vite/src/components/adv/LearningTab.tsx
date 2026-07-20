/**
 * The workspace learning loop: Observe → Improve → Verify → Retain.
 * Each stage composes the existing sync-backed panels; `?lview=` remains the
 * canonical deep-link state and `?lhive=` scopes the hive-aware views.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryState, parseAsStringEnum, parseAsString } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
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
} from "lucide-react";
import type {
  ImprovementDigest,
  ScoredItem,
} from "@papercusp/operator-core/lib/harness/improvements/digest";
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
import { tabOverflowState } from "./AdvShell";
import { BenchmarkTrend, type BenchmarkTrendInstance } from "./BenchmarkTrend";
import type { BakeoffTrendRow } from "@papercusp/operator-core/lib/pot-eval/bakeoff-trend";
import { EkgPanel } from "./EkgPanel";
import { RedQueenPanel } from "./RedQueenPanel";
import { FrontierPanel } from "./FrontierPanel";
import { SignalsPanel } from "./SignalsPanel";
import { AnalyzePanel } from "./AnalyzePanel";
import KnowledgePackCandidates from "./KnowledgePackCandidates";
import { MugWakeEfficiencyPanel } from "./MugWakeEfficiencyPanel";
import { ExperimentsPanel } from "./ExperimentsPanel";
import { Select } from "@/app/harness/Select";
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
import LearningInfraHealthChip from "./LearningInfraHealthChip";
import LearningEfficacyPanel from "./LearningEfficacyPanel";
import RubricsPanel from "@/app/_components/RubricsPanel";
import RubricDetailPanel from "@/app/_components/RubricDetailPanel";
import ObservationsPanel from "@/app/adv/create/ObservationsPanel";
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

const LVIEWS = [
  "signals",
  "observations",
  "rubrics",
  "pipeline",
  "ideas",
  "gym",
  "improvements",
  "benchmark",
  "orchestration",
  "bakeoff",
  "wake-efficiency",
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
    ideas:
      "The generator's ledger — every routed idea with its trace; your grades here teach the generator which lenses win.",
    gym: `Prompt-optimization experiments — challengers vs champions — plus ${t("scout")}-seeded archive niches.`,
    improvements:
      "The WORK queue: every captured bug/improvement agents burn down (routed ideas land here as work items). Grading the ideas that produced them lives in Ideas.",
    benchmark:
      "Whole-system benchmark runs (the IQ battery) — is a new instance measurably better?",
    orchestration: `${t("pot")}-eval scoring trends — is orchestration quality improving over time?`,
    bakeoff:
      "Comparative scoring across competing framework setups on the same tasks.",
    "wake-efficiency":
      "Are agent wakes doing useful work — wake cost versus yield.",
    ekg: "The learning loop's vital signs over time, at a glance.",
    "red-queen":
      "Adversarial-pressure tracking — is quality keeping pace as the environment hardens?",
    experiments: "A/B experiments the loop has run, and how they came out.",
    frontier: "Mined improvement territory the loop has not explored yet.",
    throughput: `Per-${pot} learning throughput — how much each ${pot} banks.`,
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
  { id: "wake-efficiency", label: "Wake efficiency", icon: Hourglass },
  { id: "ekg", label: "EKG", icon: Activity },
  { id: "red-queen", label: "Red Queen", icon: Radar },
  { id: "experiments", label: "Experiments", icon: Beaker },
  { id: "frontier", label: "Frontier", icon: Telescope },
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
      { id: "ideas", label: "Ideas", icon: Lightbulb },
      { id: "gym", label: "Gym", icon: Dumbbell },
      // "Backlog", not "Improvements" (owner confusion 2026-07-19): next to
      // "Ideas" the old name read as a second suggestion list. Ideas = grade
      // the GENERATOR's output; Backlog = the WORK queue agents burn down.
      // The lview id stays `improvements` — deep-links depend on it.
      { id: "improvements", label: "Backlog", icon: Sparkles },
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
 *  read the tab-level `?lhive=`. The rest are workspace-global (Benchmark,
 *  Scout, Knowledge — plus the EKG/RedQueen/scout-ledger panels inside them) and
 *  ignore it; Throughput already lists every hive, so it ignores it too. */
const HIVE_AWARE_VIEWS: ReadonlySet<LView> = new Set<LView>([
  "improvements",
  "gym",
  "learnings",
]);

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
  const [harnessSlug] = useQueryState("slug", parseAsString);
  // Tab-level per-Hive lens (per-hive-learning-loops P-042): ONE `?lhive=` param,
  // promoted up from the Learnings sub-view so it applies across every hive-aware
  // view. Agents drive it via ui:dispatch; the hive-creation success card
  // deep-links here with ?lhive=<slug>. Default '' ⇒ the first hive (resolved
  // once the list loads).
  const [lhive, setLhive] = useQueryState(
    "lhive",
    parseAsString.withDefault(""),
  );
  const view: LView = (LVIEWS as readonly string[]).includes(lview)
    ? (lview as LView)
    : "improvements";

  // The workspace's hives back the header picker (reuses the Learnings view's
  // query). Only fetched/shown for hive-aware views; an empty selection falls
  // back to the first hive so a fresh tab lands on a real hive.
  const hiveList = useSyncQuery<{ slug: string; remote: boolean }>({
    queryName: "learning.hiveList",
    args: {},
    staleTime: 60_000,
    enabled: HIVE_AWARE_VIEWS.has(view),
  });
  const hives = hiveList.data ?? [];
  const hiveAware = HIVE_AWARE_VIEWS.has(view);
  const hive =
    lhive ||
    hives.find((candidate) => candidate.slug === harnessSlug)?.slug ||
    hives[0]?.slug ||
    "";
  // WI-5412 perf: a hive-aware view must NOT fetch until the hive lens is
  // resolved — firing with {} and re-firing with {hive} once the hive list
  // landed made the first click pay the heavy improvements read TWICE,
  // sequentially. An explicit ?lhive= is ready immediately; otherwise wait for
  // the hive list (data present, even if empty ⇒ workspace-wide is the real
  // answer, not a transient).
  const hiveReady = !hiveAware || Boolean(lhive) || hiveList.data !== undefined;
  const activeStage = stageForView(view);
  const activeStageMeta =
    STAGES.find((stage) => stage.id === activeStage) ?? null;
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
    if (previous === "ideas") void setGradeDetail(null);
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
          const stage = STAGES.find((candidate) => candidate.id === next);
          if (stage) void setLview(stage.views[0].id);
        }}
      >
        <Tabs.List
          className="pc-learning__stage-list"
          aria-label="Learning loop stage"
        >
          {STAGES.map((stage, index) => {
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
                {index < STAGES.length - 1 ? (
                  <span className="pc-learning__stage-line" aria-hidden />
                ) : null}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
      </Tabs.Root>

      <div className="pc-learning__controls">
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

        {hiveAware ? (
          <Tooltip
            label={`Scope this view to one ${t("pot", { lower: true })}`}
          >
            <label className="pc-learning__hivepick">
              <Brain size={12} aria-hidden />
              <span className="pc-learning__hivepicklabel">
                {t("pot", { lower: true })}
              </span>
              <Select
                ariaLabel={`${t("pot")} lens`}
                value={hive}
                onChange={(next: string) => void setLhive(next)}
                disabled={hives.length === 0}
                placeholder={
                  hives.length === 0
                    ? `no ${t("pot", { plural: true, lower: true })} yet`
                    : undefined
                }
                triggerStyle={{
                  maxWidth: 200,
                  opacity: hives.length === 0 ? 0.6 : undefined,
                }}
                options={hives.map((candidate) => ({
                  value: candidate.slug,
                  label: `${hiveHomeLabel(candidate.slug)}${candidate.remote ? " (joined)" : ""}`,
                }))}
              />
            </label>
          </Tooltip>
        ) : null}
      </div>

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
  hive,
  hiveReady,
  rubricId,
  onRubricSelect,
  onStatus,
}: {
  view: LView;
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
    return <SignalsPanel onStatus={reportViewStatus} />;
  }
  if (view === "observations") {
    return <ObservationsPanel onStatus={reportViewStatus} />;
  }
  if (view === "pipeline") {
    return <AnalyzePanel onStatus={reportViewStatus} />;
  }
  if (view === "ideas") {
    return <ScoutView onStatus={reportViewStatus} />;
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
    return <GymView hive={hive} hiveReady={hiveReady} onStatus={reportViewStatus} />;
  }
  if (view === "improvements") {
    return <ImprovementsView hive={hive} hiveReady={hiveReady} onStatus={reportViewStatus} />;
  }
  if (view === "benchmark") {
    return <ApiaryView onStatus={reportViewStatus} />;
  }
  if (view === "orchestration") {
    return <HiveEvalTrendView onStatus={reportViewStatus} />;
  }
  if (view === "bakeoff") {
    return <BakeoffTrendView onStatus={reportViewStatus} />;
  }
  if (view === "wake-efficiency")
    return <MugWakeEfficiencyPanel onStatus={reportViewStatus} />;
  if (view === "ekg") return <EkgPanel onStatus={reportViewStatus} />;
  if (view === "red-queen")
    return <RedQueenPanel onStatus={reportViewStatus} />;
  if (view === "experiments")
    return <ExperimentsPanel onStatus={reportViewStatus} />;
  if (view === "frontier") return <FrontierPanel onStatus={reportViewStatus} />;
  if (view === "throughput") {
    return <ThroughputView onStatus={reportViewStatus} />;
  }
  return <LearningsView hive={hive} hiveReady={hiveReady} onStatus={reportViewStatus} />;
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

// ─── Improvements view ───────────────────────────────────────────────────────

const LANES = ["all", "auto", "human"] as const;
type Lane = (typeof LANES)[number];

function ageLabel(days: number): string {
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

function ImprovementsView({
  hive,
  hiveReady,
  onStatus,
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
}) {
  // P-042: the tab-level hive lens scopes the feed to one hive's member-harness
  // improvements; '' ⇒ the workspace-wide feed (no hive arg). Gated on
  // hiveReady (WI-5412): this is the tab's heaviest read — firing it before
  // the lens resolves paid it twice on every first click.
  const sync = useSyncQuery<ImprovementDigest & { flow?: ImprovementFlow }>({
    queryName: "learning.improvements",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const digest = sync.data?.[0];
  const t = useLexicon();
  // Drafts-in-iteration (moved here from the Ideas view — owner ask
  // 2026-07-19): a draft plan awaiting revision is WORK IN PROGRESS, so it
  // belongs on the backlog surface. Thin dedicated read, never the heavy
  // learning.scout snapshot.
  const draftsSync = useSyncQuery<ScoutDraftIteration>({
    queryName: "learning.scoutDrafts",
    args: {},
    staleTime: 60_000,
  });
  const drafts = draftsSync.data ?? [];
  const [lane, setLane] = useQueryState(
    "lane",
    parseAsStringEnum<Lane>([...LANES]).withDefault("all"),
  );
  // Source facet (`?lsrc=`): who filed it — Scout / Queen / system / … (payload.sourceRole).
  const [src, setSrc] = useQueryState("lsrc", parseAsString);
  // Selected item (`?lsel=`): set by deep-links (e.g. a Scout-routed improvement
  // click) — the row is highlighted + scrolled into view; clicking it dismisses.
  const [lsel, setLsel] = useQueryState("lsel", parseAsString);

  const allRows = useMemo<ScoredItem[]>(() => {
    if (!digest) return [];
    const base =
      lane === "auto"
        ? digest.autoEligible
        : lane === "human"
          ? digest.humanQueue
          : [...digest.autoEligible, ...digest.humanQueue];
    // Most-recent first (owner ask 2026-07-19): improvement ids (EI-NNNNN) are
    // issued sequentially, so the numeric suffix is a reliable capture-recency
    // key (the payload carries no createdAt). Newest at top.
    const idNum = (s: string) => {
      const n = parseInt(s.split("-").pop() ?? "", 10);
      return Number.isFinite(n) ? n : 0;
    };
    return [...base].sort((a, b) => idNum(b.id) - idNum(a.id));
  }, [digest, lane]);

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

  const rows = useMemo<ScoredItem[]>(
    () => (src ? allRows.filter((it) => it.source === src) : allRows),
    [allRows, src],
  );
  const sparseRows = useMemo(
    () => [...(digest?.autoEligible ?? []), ...(digest?.humanQueue ?? [])],
    [digest],
  );
  // Shared column filters + quick-search (owner ask 2026-07-19: mimic the
  // Working tab's Work Queue): the shared filter engine (`impf` param) over
  // the lane/source-scoped rows, plus a global substring quick-search
  // (`impq`) as its own affordance — the same split WorkItemsPanel uses.
  const [search, setSearch] = useQueryState(
    "impq",
    parseAsString.withDefault(""),
  );
  const filterCols = useMemo<FilterableColumn<ScoredItem>[]>(
    () => [
      { key: "kind", header: "Kind", filter: { type: "enum", accessor: (r) => r.kind } },
      { key: "severity", header: "Severity", filter: { type: "enum", accessor: (r) => r.severity ?? "—" } },
      { key: "scope", header: "Scope", filter: { type: "enum", accessor: (r) => r.scope } },
      { key: "tier", header: "Tier", filter: { type: "enum", accessor: (r) => r.tier } },
      { key: "state", header: "State", filter: { type: "enum", accessor: (r) => r.state ?? "—" } },
      { key: "ideaType", header: "Idea type", filter: { type: "enum", accessor: (r) => r.ideaType ?? "—" } },
      { key: "score", header: "Score", filter: { type: "number", accessor: (r) => r.score } },
      { key: "ageDays", header: "Age (days)", filter: { type: "number", accessor: (r) => r.ageDays } },
    ],
    [],
  );
  const cf = useColumnFilters(filterCols, rows, { ns: "imp" });
  const visibleRows = useMemo(() => {
    const q = (search ?? "").trim().toLowerCase();
    if (!q) return cf.rows;
    return cf.rows.filter((it) =>
      `${it.id} ${it.title} ${it.tierReason} ${it.scope}`
        .toLowerCase()
        .includes(q),
    );
  }, [cf.rows, search]);
  const isFiltered =
    cf.hasActive || (search ?? "").trim() !== "" || Boolean(src);

  const resolved = digest?.byState?.resolved ?? 0;
  const showDashboard = (digest?.open ?? 0) >= 4;
  useEffect(() => {
    onStatus?.(
      sync.error
        ? "bad"
        : !digest
          ? "neutral"
          : digest.humanQueue.length > 0
            ? "warn"
            : digest.open === 0
              ? "good"
              : "neutral",
    );
  }, [digest, onStatus, sync.error]);

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Sparkles}
        title="Backlog"
        question="The work queue agents burn down — every capture, not just the ones an idea produced (grade ideas in Ideas)."
        signal={digest ? `${digest.open} open` : undefined}
        tone={digest && digest.open === 0 ? "good" : "accent"}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the improvements feed"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />
      {/* Loop diagnostics behind ONE labelled disclosure (owner ask
          2026-07-19b: the instrument clusters at the top of every learning
          page were confusing — plain summary up top, gauges on demand). */}
      <LearningDisclosure
        label="How the capture loop is doing"
        subtitle="capture/resolve flow over 7 days, and whether adopted lessons hold"
      >
        {digest?.flow ? <FlowStrip flow={digest.flow} /> : null}
        <LearningEfficacyPanel />
      </LearningDisclosure>

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
                placeholder="Search improvements…"
                aria-label="Search improvements"
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
                  ? "Rows matching the current filter / search, out of the backlog total."
                  : "Backlog rows in this lane."
              }
            >
              {isFiltered
                ? `${visibleRows.length} of ${allRows.length}`
                : `${rows.length} items`}
            </span>
            {sources.length > 0 ? (
              <Select
                ariaLabel="Filter by who filed it"
                value={src ?? "__any__"}
                onChange={(v: string) =>
                  void setSrc(v === "__any__" ? null : v)
                }
                options={[
                  { value: "__any__", label: "Any source" },
                  ...sources.map((s) => ({ value: s, label: s })),
                ]}
              />
            ) : null}
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

      {sync.loading && !digest ? (
        <p className="pc-learning__empty">Loading the improvements backlog…</p>
      ) : sync.error ? (
        <LearningVisualError
          title="Improvements unavailable"
          onRetry={() => sync.invalidate()}
        />
      ) : (showDashboard ? visibleRows : sparseRows).length === 0 ? (
        <LearningVisualEmpty
          icon={CheckCircle2}
          title={
            isFiltered
              ? "Nothing matches the current filter / search"
              : "Nothing in this lane"
          }
        />
      ) : !showDashboard ? (
        <ul className="pc-learning__list pc-learning__list--direct">
          {sparseRows.map((it) => (
            <ImprovementRow
              key={it.id}
              item={it}
              selected={it.id === lsel}
              onDismissSelect={() => void setLsel(null)}
            />
          ))}
        </ul>
      ) : (
        <WindowedImprovementList
          rows={visibleRows}
          lsel={lsel}
          onDismissSelect={() => void setLsel(null)}
        />
      )}

      {/* Drafts in iteration (learning-tab-visibility P-005; moved here from
          the Ideas view, owner ask 2026-07-19): broad-scope ideas that became
          draft plans, with their revision state — the Queen↔Scout
          typed-revision loop, watchable instead of invisible. */}
      {drafts.length > 0 ? (
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

function WindowedImprovementList({
  rows,
  lsel,
  onDismissSelect,
}: {
  rows: ScoredItem[];
  lsel: string | null;
  onDismissSelect: () => void;
}) {
  const { page, rest } = useMemo(() => {
    const head = rows.slice(0, IMPROVEMENTS_PAGE);
    const tail = rows.slice(IMPROVEMENTS_PAGE);
    if (!lsel) return { page: head, rest: tail };
    const selectedInTail = tail.find((it) => it.id === lsel);
    if (!selectedInTail) return { page: head, rest: tail };
    return {
      page: [selectedInTail, ...head],
      rest: tail.filter((it) => it.id !== lsel),
    };
  }, [rows, lsel]);
  return (
    <>
      <ul className="pc-learning__list">
        {page.map((it) => (
          <ImprovementRow
            key={it.id}
            item={it}
            selected={it.id === lsel}
            onDismissSelect={onDismissSelect}
          />
        ))}
      </ul>
      {rest.length > 0 ? (
        <LearningDisclosure label="Earlier items" count={rest.length}>
          <ul className="pc-learning__list">
            {rest.map((it) => (
              <ImprovementRow
                key={it.id}
                item={it}
                selected={it.id === lsel}
                onDismissSelect={onDismissSelect}
              />
            ))}
          </ul>
        </LearningDisclosure>
      ) : null}
    </>
  );
}

function ImprovementRow({
  item,
  selected = false,
  onDismissSelect,
}: {
  item: ScoredItem;
  /** Deep-link target (?lsel) — highlighted + scrolled into view; click dismisses. */
  selected?: boolean;
  onDismissSelect?: () => void;
}) {
  const sevColor = SEVERITY[item.severity ?? "minor"].solid;
  const human = item.tier === "human";
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected]);
  return (
    <li
      ref={ref}
      className={`pc-learning__row${selected ? " pc-learning__row--selected" : ""}`}
      title={item.tierReason}
      onClick={selected ? onDismissSelect : undefined}
    >
      <span
        className="pc-learning__sev"
        style={{ background: sevColor }}
        aria-hidden
      />
      <span className="pc-learning__id">{item.id}</span>
      <span className="pc-learning__title">{item.title}</span>
      <span className="pc-learning__meta">
        <span
          className="pc-learning__chip"
          style={{ color: sevColor, borderColor: sevColor }}
        >
          {item.severity ?? "—"}
        </span>
        {item.ideaType ? (
          <span className="pc-learning__chip pc-learning__chip--idea">
            {item.ideaType}
          </span>
        ) : null}
        {item.source ? (
          <span className="pc-learning__chip" title={`Filed by ${item.source}`}>
            {item.source}
          </span>
        ) : null}
        <span
          className={`pc-learning__chip pc-learning__chip--${human ? "human" : "auto"}`}
          title={
            human ? "Waits for your review" : "An agent may fix this on its own"
          }
        >
          {human ? (
            <UserRound size={10} aria-hidden />
          ) : (
            <ShieldCheck size={10} aria-hidden />
          )}
          {human ? "review" : "auto"}
        </span>
        <span className="pc-learning__age" title="How long ago this was filed">
          {ageLabel(item.ageDays)}
        </span>
        <span
          className="pc-learning__score"
          title="Triage priority (severity + age) — higher means more urgent"
        >
          {item.score}
        </span>
      </span>
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
  rationale: string | null;
  devAnchorDelta: number | null;
  costDelta: number | null;
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
interface GymSnapshot {
  proposals: GymProposal[];
  autoloops: GymAutoloop[];
  /** Scout-seeded MAP-Elites niches (WI-5412 item 4) — absent on older server snapshots. */
  archiveSeeds?: GymArchiveSeed[];
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

/**
 * Inline 5-star grader that lives ON the idea card (owner ask 2026-07-19d) —
 * the same grade + feedback the GradePanel popup carried, no popup. Stars fill
 * to the current grade; clicking a star grades immediately; the small note
 * affordance reveals an inline feedback input whose Save submits grade + note
 * together (matching the ?grade= deep-link flow).
 */
function CardGradeStars({
  current,
  busy,
  attribution,
  feedback,
  noteOpenInit = false,
  onGrade,
}: {
  current: EffectiveGrade | null;
  busy: boolean;
  attribution: string | null;
  feedback: string | null;
  noteOpenInit?: boolean;
  onGrade: (grade: number, feedback?: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(noteOpenInit);
  const [note, setNote] = useState("");
  // A star picked while the note editor is open waits for Save (grade + note
  // submit together); with the editor closed a star click grades immediately.
  const [pendingGrade, setPendingGrade] = useState<number | null>(null);
  const shown = pendingGrade ?? current?.grade ?? 0;
  return (
    <div className={`pc-learning__stargrade${current ? " is-graded" : " is-ungraded"}`}>
      <span
        role="radiogroup"
        aria-label="Grade this idea"
        className="pc-learning__stars"
      >
        {[1, 2, 3, 4, 5].map((g) => (
          <button
            key={g}
            type="button"
            role="radio"
            aria-checked={shown === g}
            aria-label={`Grade ${g} of 5`}
            disabled={busy}
            className={`pc-learning__star${g <= shown ? " is-on" : ""}`}
            onClick={() => {
              setPendingGrade(g);
              if (!noteOpen) onGrade(g);
            }}
          >
            <Star size={15} fill={g <= shown ? "currentColor" : "none"} aria-hidden />
          </button>
        ))}
      </span>
      <span
        className="pc-learning__starmeta"
        title={feedback ? `“${feedback}”` : undefined}
      >
        {attribution ?? "ungraded — a grade teaches the generator"}
      </span>
      <button
        type="button"
        className="pc-learning__starnote"
        aria-expanded={noteOpen}
        onClick={() => setNoteOpen((v) => !v)}
      >
        {noteOpen ? "hide note" : feedback ? "note ✓" : "+ note"}
      </button>
      {noteOpen ? (
        <span className="pc-learning__stargrade-note">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this grade?"
            aria-label="Grade feedback"
          />
          <button
            type="button"
            aria-label="save grade"
            disabled={busy || shown === 0}
            onClick={() => {
              onGrade(shown, note.trim() || undefined);
              setNoteOpen(false);
            }}
          >
            Save
          </button>
        </span>
      ) : null}
    </div>
  );
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
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
}) {
  // P-042: scope the gym rollup to one hive's gym harness; '' ⇒ the whole
  // workspace (every gym harness). Gated on hiveReady (WI-5412) so the first
  // click never pays a wrong-lens fetch + refetch.
  const sync = useSyncQuery<GymSnapshot>({
    queryName: "learning.gym",
    args: hive ? { hive } : {},
    staleTime: 30_000,
    enabled: hiveReady,
  });
  const scopedSnap = sync.data?.[0];
  // Client-side safety net (owner report 2026-07-19): a hive-scoped read can come
  // back with 0 EXPERIMENTS (proposals + archiveSeeds) yet not carry
  // `scopeFallback` — e.g. the `papercusp` Hive, which owns 1 autoloop config
  // but no proposals, so the server's fallback (which the config used to make
  // look non-empty) never fired and the workspace's real proposals sat unseen
  // behind "No gym experiments". When the scoped read has no experiments and the
  // server did not already fall back, refetch the workspace-wide rollup and use
  // it. Once the matching server fix is live, `scopeFallback` is set and this
  // second read never enables. Mirrors the server's own scoped→wide fallback.
  const scopedNoExperiments =
    Boolean(scopedSnap) &&
    (scopedSnap?.proposals?.length ?? 0) === 0 &&
    (scopedSnap?.archiveSeeds?.length ?? 0) === 0;
  const needWide =
    hiveReady &&
    Boolean(hive) &&
    scopedNoExperiments &&
    !scopedSnap?.scopeFallback;
  const wideSync = useSyncQuery<GymSnapshot>({
    queryName: "learning.gym",
    args: {},
    staleTime: 30_000,
    enabled: needWide,
  });
  const wideSnap = wideSync.data?.[0];
  const useWide =
    needWide &&
    Boolean(wideSnap) &&
    ((wideSnap?.proposals?.length ?? 0) > 0 ||
      (wideSnap?.archiveSeeds?.length ?? 0) > 0);
  const snap = useWide ? wideSnap : scopedSnap;
  const proposals = snap?.proposals ?? [];
  const autoloops = snap?.autoloops ?? [];
  const archiveSeeds = snap?.archiveSeeds ?? [];
  // WI-5420: the server fell back to the workspace-wide rollup because this
  // Hive's own gym-scoped read was empty — say so, don't silently reattribute
  // another harness's experiments to this Hive. `useWide` is the client-side
  // equivalent (the scoped read had no experiments), so it reads the same note.
  const scopeFallback =
    Boolean(hive) && (Boolean(scopedSnap?.scopeFallback) || useWide);
  const activeAutoloops = autoloops.filter(
    (autoloop) => autoloop.enabled || autoloop.status === "running",
  );

  const champions = proposals.filter((p) => p.status === "accepted").length;
  const pending = proposals.filter((p) => p.status === "pending").length;
  const rejected = proposals.filter((p) => p.status === "rejected").length;
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
        title={`Path 1 — ${t("scout")} routing: every fused idea carries a routeHint from the recombine step; small, cheaply testable (prompt-shaped) ideas route to the gym rail as challenger candidates + QD-archive niche seeds. Unhinted ideas default to the improvement rail; plans/benchmarks have their own rails. Path 2 — the autoloop: a per-${t("pot", { lower: true })} config (enabled + an explicit budget cap — no cap, no unattended runs); a 30-min routine round-robins enabled ${t("pot", { plural: true, lower: true })} and runs one budget-bounded challenger-vs-champion cycle, accumulating spend until the budget floor stops it. Proposals never auto-promote — accept/reject is yours.`}
      >
        Two ways in: {t("scout")} routes small, cheaply testable ideas here
        (challengers + archive niche seeds), and each enabled, budgeted{" "}
        {t("pot", { lower: true })} autoloop runs challenger-vs-champion cycles
        (~every 30 min) until its budget is spent. Nothing promotes itself —
        you accept or reject every challenger.
      </p>

      {scopeFallback ? (
        <p
          className="pc-learning__muted pc-learning__scopenote"
          title={`This ${t("pot")}'s own gym harness has no recorded experiments; showing the workspace-wide rollup instead so real data is never hidden.`}
        >
          {`Showing gym experiments from all ${t("pot", { plural: true, lower: true })} — none are scoped to this ${t("pot")} yet.`}
        </p>
      ) : null}

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
      {(!snap && !sync.error) || (needWide && !wideSnap && !wideSync.error) ? (
        <p className="pc-learning__empty">Loading gym experiments…</p>
      ) : sync.error ? (
        <LearningVisualError
          title="Gym unavailable"
          onRetry={() => sync.invalidate()}
        />
      ) : proposals.length === 0 && archiveSeeds.length === 0 ? (
        <LearningVisualEmpty
          icon={Dumbbell}
          title="No gym experiments in this workspace yet"
        />
      ) : (
        <>
          {proposals.length > 0 ? (
            <>
              <div className="pc-learning__sectionhead">
                <h2>Recent challengers</h2>
              </div>
              <ul className="pc-learning__list">
                {proposals.map((p) => (
                  <GymProposalRow key={p.id} p={p} />
                ))}
              </ul>
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
              <ul className="pc-learning__list">
                {archiveSeeds.map((s) => (
                  <li
                    key={`${s.harnessSlug}:${s.nicheKey}`}
                    className="pc-learning__row pc-learning__row--gym"
                    title={s.rationale ?? undefined}
                  >
                    <span
                      className="pc-learning__sev"
                      style={{ background: "var(--accent, #7dd3fc)" }}
                      aria-hidden
                    />
                    <span className="pc-learning__id">{s.candidateId}</span>
                    <span className="pc-learning__title">
                      {s.rationale || (
                        <em className="pc-learning__muted">(no rationale)</em>
                      )}
                    </span>
                    <span className="pc-learning__meta">
                      <span
                        className="pc-learning__chip pc-learning__chip--idea"
                        title="The MAP-Elites niche this seed holds (scope | domain | risk)"
                      >
                        {s.nicheKey}
                      </span>
                      <span
                        className="pc-learning__chip"
                        title="Seed fitness prior — higher holds the niche against challengers"
                      >
                        fit {s.fitness.toFixed(2)}
                      </span>
                      <span className="pc-learning__age">
                        {whenLabel(s.updatedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function GymProposalRow({ p }: { p: GymProposal }) {
  const statusColor = statusToneColor(p.status);
  const delta = deltaLabel(p.devAnchorDelta);
  return (
    <li
      className="pc-learning__row pc-learning__row--gym"
      title={p.rationale ?? undefined}
    >
      <span
        className="pc-learning__sev"
        style={{ background: statusColor }}
        aria-hidden
      />
      <span className="pc-learning__id">{p.role}</span>
      <span className="pc-learning__title">
        {p.rationale || <em className="pc-learning__muted">(no rationale)</em>}
      </span>
      <span className="pc-learning__meta">
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
          {p.status}
        </span>
        <span
          className="pc-learning__chip pc-learning__chip--idea"
          title="The gym harness that ran this experiment"
        >
          {p.harnessSlug}
        </span>
        <span
          className={`pc-learning__delta pc-learning__delta--${delta.tone}`}
          title="Judge-score change vs the current prompt — positive means the variant did better"
        >
          Δ {delta.text}
        </span>
        <span
          className="pc-learning__age"
          title={`Experiment cycle ${p.cycle}`}
        >
          c{p.cycle}
        </span>
        <span className="pc-learning__age">
          {whenLabel(p.decidedAt ?? p.createdAt)}
        </span>
      </span>
    </li>
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
}: {
  onStatus?: (status: LearningViewStatus) => void;
}) {
  const sync = useSyncQuery<{ instances: ApiaryInstance[] }>({
    queryName: "learning.apiary",
    args: {},
    staleTime: 30_000,
  });
  const instances = sync.data?.[0]?.instances ?? [];
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
      ) : sync.error ? (
        <LearningVisualError
          title="Benchmark unavailable"
          onRetry={() => sync.invalidate()}
        />
      ) : !latest && !pending ? (
        <LearningVisualEmpty icon={Gauge} title="No benchmark runs" />
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
}: {
  onStatus?: (status: LearningViewStatus) => void;
}) {
  const t = useLexicon();
  const sync = useSyncQuery<{ instances: HiveEvalGeneration[] }>({
    queryName: "learning.hiveEvalTrend",
    args: {},
    staleTime: 30_000,
  });
  const instances = sync.data?.[0]?.instances ?? [];
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

      {!latest ? (
        <LearningVisualEmpty
          icon={Activity}
          title={`No ${t("pot")}-eval runs`}
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
}: {
  onStatus?: (status: LearningViewStatus) => void;
}) {
  const sync = useSyncQuery<{ rows: BakeoffTrendRow[] }>({
    queryName: "learning.bakeoff",
    args: {},
    staleTime: 30_000,
  });
  const rows = sync.data?.[0]?.rows ?? [];
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
            Δcomp {dc.text}
          </span>
          <span className="pc-learning__benchmeta">
            Δgate {r.deltaGatePassRate >= 0 ? "+" : ""}
            {r.deltaGatePassRate.toFixed(2)}
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

      {!latest || !latestMeta || !latestComposite ? (
        <LearningVisualEmpty icon={Repeat2} title="No bake-offs" />
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
const lensAbbrev = (lens: string): string =>
  lens
    .split("-")
    .map((w) => w[0] ?? "")
    .join("");

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
  onStatus,
}: {
  onStatus?: (status: LearningViewStatus) => void;
}) {
  const t = useLexicon();
  const sync = useSyncQuery<HiveThroughputSnapshot>({
    queryName: "learning.hiveThroughput",
    args: {},
    staleTime: 30_000,
  });
  const soak = useSyncQuery<PotSoakReportSnapshot>({
    queryName: "learning.soakReport",
    args: {},
    staleTime: 60_000,
  });
  const hives = sync.data?.[0]?.hives ?? [];
  const soakByHive = new Map(
    (soak.data?.[0]?.hives ?? []).map((report) => [report.potSlug, report]),
  );
  useEffect(() => {
    onStatus?.(
      sync.error || soak.error
        ? "bad"
        : hives.some((hive) => !hive.operatingWell)
          ? "warn"
          : hives.length > 0
            ? "good"
            : "neutral",
    );
  }, [hives, onStatus, soak.error, sync.error]);

  return (
    <section className="pc-learning__section">
      {hives.length === 0 ? (
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
                {report ? (
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
export function ScoutView({
  onStatus,
}: {
  onStatus?: (status: LearningViewStatus) => void;
} = {}) {
  const t = useLexicon();
  const RAIL_META = railMeta(t);
  const sync = useSyncQuery<ScoutSnapshot>({
    queryName: "learning.scout",
    args: {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const rails = snap?.railCounts ?? [];
  const recent = snap?.recent ?? [];
  const tick = snap?.lastTick ?? null;
  const tickMs = tick?.at ? Date.parse(tick.at) : NaN;
  // P-002: tick-economics rows (newest first). Older server snapshots (pre-P-002
  // deploy) lack the field — degrade to the empty strip, never a crash.
  const econTicks = snap?.ticks ?? [];
  // P-003: the server-evaluated drift markers (the blender-release-readiness
  // rubric's driftMarkers ARE the health spec — evaluated in
  // learning-scout-read.ts, never re-derived here). Pre-P-003 snapshots lack
  // the field — degrade to neutral.
  const health = snap?.health ?? { status: "neutral" as const, markers: [] };
  // learning-tab-visibility P-001: the live cadence/firing state. Pre-deploy
  // snapshots lack the field — the card simply doesn't render.
  const cadence = snap?.cadence ?? null;
  // (Drafts-in-iteration moved to the Improvements view — owner ask 2026-07-19;
  // it reads the thin learning.scoutDrafts resolver there, not this snapshot.)

  // Grading (P-006): the note popover's open-state is URL state (`?grade=<ideaId>`)
  // so agents can drive it; in-flight optimistic grades + errors are transient
  // lifecycle → useState. A grade from this surface is an OWNER grade (the
  // server derives gradedBy from the caller — C-3); owner regrade is always
  // allowed, so the stars stay interactive on graded rows.
  const [gradeOpen, setGradeOpen] = useQueryState("grade", parseAsString);
  const [railFilter, setRailFilter] = useQueryState("irail", parseAsString);
  // P-004: the pipeline-trace expansion is URL state (`?itrace=<ideaId>`) so
  // agents can drive it — clicking an idea shows its whole loop (grounding →
  // lens → route → grade → outcome), not four silos.
  const [traceOpen, setTraceOpen] = useQueryState("itrace", parseAsString);
  // Titles for the opaque wi: grounding refs (server-resolved, P-004);
  // pre-deploy snapshots lack the field — fall back to the raw ref.
  const groundingTitles = snap?.groundingTitles ?? {};
  const [optimistic, setOptimistic] = useState<Record<string, EffectiveGrade>>(
    {},
  );
  const [savingId, setSavingId] = useState("");
  const [gradeError, setGradeError] = useState("");
  const filteredRecent = useMemo(
    () =>
      railFilter ? recent.filter((item) => item.rail === railFilter) : recent,
    [railFilter, recent],
  );
  // P-003: the view badge evaluates the rubric's drift markers (server-derived
  // health), NOT data-presence — "there are rows" is not "the loop is healthy".
  useEffect(() => {
    onStatus?.(sync.error ? "bad" : health.status);
  }, [health.status, onStatus, sync.error]);

  const effectiveGrade = (item: ScoutRoutedItem): EffectiveGrade | null => {
    const opt = optimistic[item.ideaId];
    if (opt) return opt;
    if (item.humanGrade == null) return null;
    return {
      grade: item.humanGrade,
      feedback: item.humanFeedback ?? null,
      gradedBy: item.gradedBy ?? "owner",
    };
  };
  const reviewItems = filteredRecent.filter((item) => !effectiveGrade(item));
  const reviewedItems = filteredRecent.filter((item) => effectiveGrade(item));
  // Two DISTINCT ungraded sections (owner ask 2026-07-19): the decision queue
  // (the 8 highest-priority to grade now) and everything older behind its own
  // disclosure — no longer one truncated list toggled in place.
  const DECISION_QUEUE_SIZE = 8;
  const decisionQueue = reviewItems.slice(0, DECISION_QUEUE_SIZE);
  const earlierUngraded = reviewItems.slice(DECISION_QUEUE_SIZE);

  const submitGrade = async (
    item: ScoutRoutedItem,
    grade: number,
    feedback: string | null,
  ) => {
    setGradeError("");
    setSavingId(item.ideaId);
    const prevEntry = optimistic[item.ideaId] ?? null;
    // Optimistic: show the new grade immediately; the refetched snapshot
    // confirms it (or the catch below rolls it back).
    setOptimistic((m) => ({
      ...m,
      [item.ideaId]: { grade, feedback, gradedBy: "owner" },
    }));
    try {
      const res = await fetch("/api/agent-tools/scout/grade-idea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ideaId: item.ideaId,
          grade,
          ...(feedback ? { feedback } : {}),
        }),
      });
      const raw: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = unwrapToolResult(raw);
      if (result.applied === false)
        throw new Error(String(result.reason ?? "grade not applied"));
      sync.invalidate();
    } catch (e) {
      setOptimistic((m) => {
        const next = { ...m };
        if (prevEntry) next[item.ideaId] = prevEntry;
        else delete next[item.ideaId];
        return next;
      });
      setGradeError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId("");
    }
  };

  // Steering visibility (P-007): the persisted per-lens sampling weights,
  // shown as shares of the total so they read as "how Scout will lean".
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

  // Deep-links: a routed idea opens its artifact's home surface (all nuqs, so
  // agents can drive the same navigation via ui:dispatch).
  const [, setTab] = useQueryState("tab", parseAsString);
  const [, setCreateView] = useQueryState("view", parseAsString);
  const [, setPlanSel] = useQueryState("plan", parseAsString);
  const [, setLviewRaw] = useQueryState("lview", parseAsString);
  const [, setLhiveRaw] = useQueryState("lhive", parseAsString);
  const [, setLane] = useQueryState("lane", parseAsString);
  const [, setSrcSel] = useQueryState("lsrc", parseAsString);
  const [, setLsel] = useQueryState("lsel", parseAsString);
  // The improvements backlog, selecting THAT row (?lsel) and resetting the
  // lane/source filters so the target is guaranteed visible (a sticky
  // lane=auto would hide a human-tier item and the click would look like a
  // no-op). Shared by openRouted and the trace's wi: grounding chips (P-004).
  const openImprovement = (id: string) => {
    void setLsel(id);
    void setLane(null);
    void setSrcSel(null);
    void setLviewRaw("improvements");
  };
  // Deep-link a plan slug into Create → Plans — shared by the routed-artifact
  // chip AND the plan: grounding chips (owner ask 2026-07-19: a plan in
  // "grounded in" must be clickable and land on the plan in the Create tab).
  const openPlan = (slug: string) => {
    void setPlanSel(slug);
    void setCreateView("plans");
    void setTab("plans");
  };
  const openRouted = (item: ScoutRoutedItem) => {
    if (item.rail === "plan" && item.routedRef.startsWith("plan:")) {
      openPlan(item.routedRef.slice("plan:".length));
    } else if (item.rail === "gym") {
      // WI-5412 item 4: carry the idea's hive so the Gym view opens on the
      // seed's data, not the default hive's (empty) challengers. The ledger
      // doesn't stamp harness_slug consistently (EI-10520) — when absent,
      // navigate without touching the lens.
      if (item.harnessSlug) void setLhiveRaw(item.harnessSlug);
      void setLviewRaw("gym");
    } else if (item.rail === "instance") {
      void setLviewRaw("benchmark");
    } else {
      // improvement (wi:EI-…) and anything unknown → the improvements backlog.
      openImprovement(
        item.routedRef.startsWith("wi:")
          ? item.routedRef.slice("wi:".length)
          : item.routedRef,
      );
    }
  };
  // P-004: one grounding-evidence chip. wi: refs get their resolved title and
  // deep-link to the improvements backlog; the other typed refs
  // (fact:/rubric:/watchdog:/plan:/…) are already readable slugs.
  const renderGroundingChip = (ref: string) => {
    const sep = ref.indexOf(":");
    const kind = sep > 0 ? ref.slice(0, sep) : "ref";
    const rest = sep > 0 ? ref.slice(sep + 1) : ref;
    if (kind === "wi") {
      const title = groundingTitles[ref];
      return (
        <Tooltip
          key={ref}
          label={
            title
              ? `${rest} — ${title} (open in Improvements)`
              : `${rest} — open in Improvements`
          }
        >
          <button
            type="button"
            className="pc-learning__tracechip pc-learning__tracechip--link"
            onClick={() => openImprovement(rest)}
          >
            <i>{kind}</i>
            {title ? `${rest} · ${title}` : rest}
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
            onClick={() => openPlan(rest)}
          >
            <i>{kind}</i>
            {rest}
          </button>
        </Tooltip>
      );
    }
    return (
      <span key={ref} className="pc-learning__tracechip" title={ref}>
        <i>{kind}</i>
        {rest}
      </span>
    );
  };

  // P-004: the pipeline trace — the idea's whole loop as ONE row of stages:
  // grounding evidence → lens → routed artifact → grade → outcome. Every field
  // comes from the same ledger read the list renders (D-001); a missing stage
  // renders dimmed (the gap IS the signal — e.g. "ungraded" on a starving
  // grading loop).
  const renderTrace = (item: ScoutRoutedItem) => {
    const meta = RAIL_META[item.rail] ?? {
      label: item.rail,
      desc: "Routed idea",
      color: "#94a3b8",
    };
    // Pre-P-004 server snapshots lack the field — degrade to "none recorded".
    const refs = item.addressesPatternRefs ?? [];
    const eff = effectiveGrade(item);
    const outcome = item.outcome ?? "pending";
    const outcomeTone =
      outcome === "won" ? "good" : outcome === "lost" ? "bad" : "missing";
    // Display the ref WITHOUT its rail prefix — the rail chip already names
    // the destination (owner ask 2026-07-19: the gym/plan link boxes were
    // unreadable "gym gym:SP-004" doubles).
    const shortRef = item.routedRef.replace(/^[a-z]+:/i, "");
    return (
      <div
        className="pc-learning__trace"
        aria-label={`Pipeline trace for ${item.title ?? item.routedRef}`}
      >
        <div
          className={`pc-learning__tracerow${refs.length === 0 ? " is-missing" : ""}`}
        >
          <em>grounded in</em>
          <span className="pc-learning__tracechips">
            {refs.length > 0 ? (
              refs.map(renderGroundingChip)
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
              item.cycleId
                ? `Produced by the '${item.lens}' lens in cycle ${item.cycleId}`
                : `Produced by the '${item.lens}' lens`
            }
          >
            {item.lens}
            {item.origin ? <i> · {item.origin}</i> : null}
          </strong>
        </div>
        <div className="pc-learning__tracerow">
          <em>routed to</em>
          <span className="pc-learning__tracechips">
            <Tooltip label={`${meta.desc} — open ${item.routedRef}`}>
              <button
                type="button"
                className="pc-learning__tracechip pc-learning__tracechip--link"
                onClick={() => openRouted(item)}
              >
                <i
                  className="pc-learning__tracedot"
                  style={{ background: meta.color }}
                  aria-hidden
                />
                <span>{meta.label}</span>
                <b>{shortRef}</b>
              </button>
            </Tooltip>
          </span>
        </div>
        <div className={`pc-learning__tracerow${eff ? "" : " is-missing"}`}>
          <em>grade</em>
          <strong
            title={
              eff
                ? (eff.feedback ??
                  `Graded by ${graderLabel(eff.gradedBy, t("brain"))}`)
                : "Ungraded — the grade→learn half of the loop has not seen this idea."
            }
          >
            {eff
              ? `★${eff.grade} · ${graderLabel(eff.gradedBy, t("brain"))}`
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
  };

  const renderIdeaRow = (item: ScoutRoutedItem) => {
    const meta = RAIL_META[item.rail] ?? {
      label: item.rail,
      desc: "Routed idea",
      color: "#94a3b8",
    };
    const when = item.routedAt ? Date.parse(item.routedAt) : NaN;
    const eff = effectiveGrade(item);
    const isOpen = gradeOpen === item.ideaId;
    const isTraceOpen = traceOpen === item.ideaId;
    const saving = savingId === item.ideaId;
    return (
      <li
        key={item.ideaId}
        className="pc-learning__row pc-learning__row--scout"
      >
        <Tooltip
          label={
            isTraceOpen
              ? "Hide this idea's pipeline trace"
              : "Show this idea's pipeline trace — grounding, lens, route, grade, outcome"
          }
        >
          <button
            type="button"
            className="pc-learning__rowmain"
            aria-expanded={isTraceOpen}
            onClick={() => void setTraceOpen(isTraceOpen ? null : item.ideaId)}
          >
            <span
              className="pc-learning__sev"
              style={{ background: meta.color }}
              aria-hidden
            />
            <span className="pc-learning__id" style={{ color: meta.color }}>
              {meta.label}
            </span>
            <span className="pc-learning__title">
              {item.title ?? item.routedRef}
            </span>
          </button>
        </Tooltip>
        <span className="pc-learning__meta">
          <span
            className="pc-learning__chip pc-learning__chip--idea"
            title="Creative lens that produced this idea"
          >
            {item.lens}
          </span>
          {item.outcome && item.outcome !== "pending" ? (
            <span
              className="pc-learning__score"
              title="Outcome from the change feed"
            >
              {item.outcome}
            </span>
          ) : null}
          <span className="pc-learning__age">
            {!Number.isNaN(when) ? whenLabel(when) : ""}
          </span>
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
                    ? `Graded by ${graderLabel(eff.gradedBy, t("brain"))}: “${eff.feedback}”`
                    : `Graded by ${graderLabel(eff.gradedBy, t("brain"))}`
                }
              >
                ★{eff.grade} · {graderLabel(eff.gradedBy, t("brain"))}
              </span>
            ) : null}
            <Popover
              open={isOpen}
              onOpenChange={(open) =>
                void setGradeOpen(open ? item.ideaId : null)
              }
              trigger={
                <button
                  type="button"
                  className="pc-learning__notebtn"
                  aria-label={eff ? "Review idea grade" : "Grade this idea"}
                  aria-expanded={isOpen}
                >
                  {eff ? (
                    <Star size={12} fill="currentColor" aria-hidden />
                  ) : (
                    <MessageSquarePlus size={12} aria-hidden />
                  )}
                </button>
              }
              tooltipLabel={eff ? "Review this grade" : "Grade this idea"}
              ariaLabel={`Grade ${item.title ?? item.routedRef}`}
              contentClassName="pc-learning__gradepopover"
            >
              <GradePanel
                current={eff}
                busy={saving}
                onSave={(grade, feedback) => {
                  void submitGrade(item, grade, feedback).then(
                    () => void setGradeOpen(null),
                  );
                }}
                onClose={() => void setGradeOpen(null)}
              />
            </Popover>
          </span>
        </span>
        {isTraceOpen ? renderTrace(item) : null}
      </li>
    );
  };

  // Card variant of an idea for the overlapping-stack browser (owner ask
  // 2026-07-19). The lens rides the GROUP header (renderLensStacks), so the
  // card omits the lens chip — the whole stack is one lens. Same interactive
  // grade + trace affordances as the row.
  const renderIdeaCard = (item: ScoutRoutedItem) => {
    const meta = RAIL_META[item.rail] ?? {
      label: item.rail,
      desc: "Routed idea",
      color: "#94a3b8",
    };
    const when = item.routedAt ? Date.parse(item.routedAt) : NaN;
    const eff = effectiveGrade(item);
    const isOpen = gradeOpen === item.ideaId;
    const saving = savingId === item.ideaId;
    return (
      <div className="pc-learning__ideacard">
        <div className="pc-learning__ideacard-head">
          <span
            className="pc-learning__id"
            style={{ color: meta.color }}
            title={meta.desc}
          >
            <span
              className="pc-learning__sev"
              style={{ background: meta.color }}
              aria-hidden
            />
            {meta.label}
          </span>
          {item.outcome && item.outcome !== "pending" ? (
            <span
              className={`pc-learning__score pc-learning__score--${item.outcome}`}
              title="Outcome from the change feed"
            >
              {item.outcome}
            </span>
          ) : null}
          <span className="pc-learning__age">
            {!Number.isNaN(when) ? whenLabel(when) : ""}
          </span>
        </div>
        <Tooltip label={`Open the routed artifact — ${item.routedRef}`}>
          <button
            type="button"
            className="pc-learning__ideacard-title"
            onClick={() => openRouted(item)}
          >
            {item.title ?? item.routedRef}
          </button>
        </Tooltip>
        {/* Inline star grader ON the card (owner ask 2026-07-19d) — the same
            grade+note the popup carried, always visible, no popup. */}
        <CardGradeStars
          current={eff}
          busy={saving}
          attribution={
            eff ? `★${eff.grade} · ${graderLabel(eff.gradedBy, t("brain"))}` : null
          }
          feedback={eff?.feedback ?? null}
          noteOpenInit={isOpen}
          onGrade={(grade, feedback) => {
            void submitGrade(item, grade, feedback ?? null).then(
              () => void setGradeOpen(null),
            );
          }}
        />
        {/* The FULL story rides the card (owner ask 2026-07-19): the pipeline
            trace is always visible — never behind a click-to-reveal. */}
        {renderTrace(item)}
      </div>
    );
  };

  // Group ungraded ideas by their producing lens ("first-principles reframing",
  // …) and render each lens as its own overlapping card stack (owner ask
  // 2026-07-19). Biggest stacks first so the dominant lenses lead.
  const renderLensStacks = (items: ScoutRoutedItem[], keyPrefix: string) => {
    const groups = new Map<string, ScoutRoutedItem[]>();
    for (const it of items) {
      const lens = it.lens || "unknown";
      const bucket = groups.get(lens);
      if (bucket) bucket.push(it);
      else groups.set(lens, [it]);
    }
    const ordered = [...groups.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    return (
      <div className="pc-learning__lensstacks">
        {ordered.map(([lens, group]) => (
          <section
            key={`${keyPrefix}-${lens}`}
            className="pc-learning__lensgroup"
            aria-label={`${lens} ideas`}
          >
            <CardStack
              items={group}
              getKey={(it) => it.ideaId}
              ariaLabel={`${lens} ungraded ideas`}
              accent={lensColor(lens)}
              // The lens badge rides ON the active card's top edge (CardStack
              // renders it overlapping), so the association is unmistakable.
              header={
                <>
                  <span
                    className="pc-cardstack__header-label"
                    title="Creative lens"
                  >
                    {lens}
                  </span>
                  <span className="pc-cardstack__header-count">
                    {group.length}
                  </span>
                </>
              }
              renderCard={(it) => renderIdeaCard(it)}
            />
          </section>
        ))}
      </div>
    );
  };

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Lightbulb}
        title="Ideas"
        question="The generator's ledger: idea → artifact trace + grading — routed rows are links into the real backlog, not a second one."
        signal={snap ? `${snap.totalRouted} routed` : undefined}
        tone={health.status}
        action={
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label={`Reload the ${t("scout", { lower: true })} feed`}
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        }
      />
      {/* ONE plain-language glance line (owner ask 2026-07-19: the stacked
          instrument clusters were unreadable). Every gauge behind ONE labelled
          disclosure below. */}
      <p className="pc-learning__glance" aria-label="Ideas at a glance">
        <span title="Every idea a cycle turned into an artifact (work item, gym seed, plan, benchmark).">
          <strong>{snap?.totalRouted ?? 0}</strong> ideas routed
        </span>
        {snap?.improveFunnel ? (
          <span title="Ideas filed onto the improvement rail that are now resolved or closed.">
            <strong>{snap.improveFunnel.done}</strong> done
          </span>
        ) : null}
        {cadence ? (
          <span
            title={`A weighted score over pending signal (new observations, captures, reverts, completions…) fires the next idea cycle at ≥${cadence.threshold}. Details in "How the cycle engine is doing".`}
          >
            next cycle{" "}
            <strong>
              {cadence.score >= cadence.threshold
                ? "armed — fires on the next sweep"
                : `waiting for signal (${Math.round(cadence.score * 10) / 10} of ${cadence.threshold})`}
            </strong>
          </span>
        ) : null}
        {tick && !Number.isNaN(tickMs) ? (
          <span title="When the cycle engine last ticked.">
            last ran <strong>{whenLabel(tickMs)}</strong>
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

      {/* The instruments, together and labelled: drift warnings, the firing
          gauge, the per-tick history, and the idea→work funnel. */}
      <LearningDisclosure
        label="How the cycle engine is doing"
        subtitle="what fires a cycle, the recent runs, and where routed ideas went"
      >
      {health.markers.length > 0 ? (
        <ul className="pc-learning__warnlist" aria-label="Ideas health warnings">
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

      {/* Cadence card (learning-tab-visibility P-001): the LIVE firing state —
          per-lane pending signal + the weighted score vs the volume gate's
          threshold, from the same reader + score function the gate consumes.
          Answers "why isn't it firing / what will make it fire" without a
          PG query. */}
      {cadence ? <CadenceCard cadence={cadence} scoutWord={t("scout")} /> : null}

      {/* Tick-economics strip (learning-tab-alignment P-002): the last N ticks'
          stop reason, spend, generated→routed funnel + lens mix — the columns
          where the 17-day WI-4482 lens collapse and the budget-exhausted
          starvation lived, invisibly. Newest first; same ledger rows the
          quality/success metrics judge from (D-001). */}
      <div
        className="pc-learning__tickstrip pc-learning__tickstrip--rows"
        role="list"
        aria-label={`${t("scout")} tick economics, newest first`}
      >
        {econTicks.length === 0 ? (
          <span
            className="pc-learning__flowchip"
            title={`${t("scout")} records a row per tick (stop reason, spend, ideas generated/routed) — no ticks recorded yet.`}
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
            void lensPairs;
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

      {/* Improve-stage funnel (WI-5412 item 3): ideas → filed → claimed → done
          — what the routed work actually did, distinct from grading (which
          teaches the generator). Server-derived (improveFunnel leg). */}
      {snap?.improveFunnel ? (
        <div
          className="pc-learning__improvementflow pc-learning__improvementflow--funnel"
          aria-label="Idea-to-work funnel"
        >
          <span title="Every idea a cycle routed onto a rail (work item, gym seed, plan, benchmark).">
            <small>Ideas routed</small>
            <strong>{snap.improveFunnel.routed}</strong>
          </span>
          <i aria-hidden />
          <span title="Routed onto the improvement rail — filed as a work item.">
            <small>Filed</small>
            <strong>{snap.improveFunnel.filed}</strong>
          </span>
          <i aria-hidden />
          <span title="Filed items currently claimed by an agent (open + assigned).">
            <small>Claimed</small>
            <strong>{snap.improveFunnel.claimed}</strong>
          </span>
          <i aria-hidden />
          <span className="is-good" title="Filed items resolved or closed.">
            <small>Done</small>
            <strong>{snap.improveFunnel.done}</strong>
          </span>
        </div>
      ) : null}
      </LearningDisclosure>

      {/* Lens weights — always visible under a standard header (owner ask
          2026-07-19: "should always be visible, it never takes up much space").
          Drafts-in-iteration moved to the Improvements view the same day (a
          draft plan awaiting revision is backlog work, not generator ledger). */}
      {lensEntries.length > 0 ? (
        <>
          <div className="pc-learning__sectionhead pc-learning__sectionhead--desc">
            <h2>Lens weights</h2>
            <span
              className="pc-learning__sectionsub"
              title={`${t("scout")} picks its creative lenses with these sampling weights — learned from routed-idea outcomes and grades (a ★5 counts as a win, a ★1 as a loss; a grade beats the system's own outcome guess).`}
            >
              the ideator's learned creative-lens steering — raised by wins and
              good grades
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
      ) : null}

      {/* Rail-filter row (owner ask 2026-07-19): moved to sit DIRECTLY above the
          "Routed ideas" list it filters, instead of stranded above the
          lens-weights/drafts disclosures it has nothing to do with. */}
      {snap ? (
        <div className="pc-learning__idea-filters" aria-label="Idea routing">
          <button
            type="button"
            aria-pressed={!railFilter}
            onClick={() => void setRailFilter(null)}
          >
            <Radar size={11} aria-hidden />
            All <strong>{snap.totalRouted}</strong>
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

      {/* One compact header line (owner ask 2026-07-19): the explanation rides
          small NEXT TO the title instead of standing sections of copy. */}
      <div className="pc-learning__sectionhead pc-learning__sectionhead--desc">
        <h2>Routed ideas</h2>
        <span
          className="pc-learning__sectionsub"
          title="Every idea a cycle turned into an artifact (work item, gym seed, plan, benchmark). Ungraded ideas stack by lens below — grade the top of each stack; ★1–5 teaches the generator which lenses win, and the artifact itself lives in its rail's home (Improvements, Gym, Plans, Benchmark)."
        >
          every idea a cycle turned into an artifact — grade the top of each
          lens stack (★1–5 teaches the generator); the work itself lives in its
          rail's home
        </span>
      </div>

      {sync.loading && !snap ? (
        <p className="pc-learning__empty">
          Loading the {t("scout", { lower: true })} ledger…
        </p>
      ) : sync.error ? (
        <LearningVisualError
          title={`${t("scout")} unavailable`}
          onRetry={() => sync.invalidate()}
        />
      ) : filteredRecent.length === 0 ? (
        <LearningVisualEmpty icon={Radar} title={`No routed ideas`} />
      ) : (
        <>
          {gradeError ? (
            <p className="pc-learning__empty" role="alert">
              Grade failed: {gradeError}
            </p>
          ) : null}
          {/* Decision queue — the highest-priority ungraded, grouped into
              per-lens overlapping stacks, straight under the header (its copy
              lives in the header's small line — owner ask 2026-07-19). */}
          {decisionQueue.length > 0 ? (
            renderLensStacks(decisionQueue, "queue")
          ) : (
            <LearningVisualEmpty
              icon={CheckCircle2}
              title="Review queue clear"
            />
          )}
          {/* Earlier ungraded — everything past the decision queue, visually
              SEPARATE behind its own disclosure, same per-lens stacks. */}
          {earlierUngraded.length > 0 ? (
            <LearningDisclosure
              label="Earlier ungraded ideas"
              count={earlierUngraded.length}
            >
              {renderLensStacks(earlierUngraded, "earlier")}
            </LearningDisclosure>
          ) : null}
          {reviewedItems.length > 0 ? (
            <>
              {/* WI-5412 item 3: "graded", not "reviewed" — the 1–5 stars teach
                  the GENERATOR (lens weights); routing to a rail already
                  happened at cycle time. The old label read as an acceptance
                  step it never was. */}
              <LearningDisclosure
                label="Graded ideas"
                count={reviewedItems.length}
              >
                <p className="pc-learning__gradednote">
                  Grades teach the generator — routing already happened when
                  the cycle fired.
                </p>
                <ul className="pc-learning__list">
                  {reviewedItems.map(renderIdeaRow)}
                </ul>
              </LearningDisclosure>
            </>
          ) : null}
        </>
      )}
    </section>
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
}: {
  hive: string;
  hiveReady: boolean;
  onStatus?: (status: LearningViewStatus) => void;
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

  const sync = useSyncQuery<HiveLearningsSnapshot>({
    queryName: "learning.hive",
    args: { hive },
    enabled: hiveReady && hive.length > 0,
    staleTime: 30_000,
  });
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

        {hive === "" ? (
          <div className="pc-learning__quietempty" role="status">
            <Brain size={14} aria-hidden />
            <span>No {t("pot", { plural: true, lower: true })}</span>
          </div>
        ) : sync.loading && !snap ? (
          <p className="pc-learning__quietempty">
            Loading the {t("pot", { lower: true })}&rsquo;s shared memory…
          </p>
        ) : snap?.unavailable ? (
          <LearningVisualError
            title="Shared memory unavailable"
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
                    const good = ["resolved", "closed", "active", "adopted", "shipped"].includes(d.outcome);
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
        margin-left: auto;
        padding: 5px 10px; font-size: 11.5px; font-weight: 600; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg-2); color: var(--fg-mute);
      }
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
        gap: 6px 12px; align-items: start;
        margin-top: 9px; padding: 9px 12px; border-radius: 9px;
        border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 10%, var(--border, rgba(125, 211, 252, 0.14)));
        background: color-mix(in srgb, var(--bg-1, #0d151d) 55%, transparent);
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
      .pc-learning__tracechip b { font-weight: 680; color: var(--fg, #e7eef5); overflow: hidden; text-overflow: ellipsis; }
      .pc-learning__tracechip {
        display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 8px;
        font-size: 10.5px; font-weight: 600; border-radius: 6px; font-family: inherit;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.04)); color: var(--fg-dim, #b9d4e8);
        /* WRAP long refs — clipping cut fact/plan slugs unreadably mid-token
           (owner screenshot 2026-07-19 19:31). */
        max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left;
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
      .pc-learning__chip--auto { color: #86efac; border-color: rgba(134, 239, 172, 0.5); }
      .pc-learning__chip--human { color: #fcd34d; border-color: rgba(252, 211, 77, 0.5); }
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
      /* ── Inline star grader on the idea card (owner ask 2026-07-19d) ───── */
      .pc-learning__stargrade {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 6px 8px; border-radius: 8px;
        border: 1px dashed color-mix(in srgb, #fbbf24 35%, var(--border, rgba(125, 211, 252, 0.16)));
        background: color-mix(in srgb, #fbbf24 4%, transparent);
      }
      .pc-learning__stargrade.is-graded {
        border-style: solid;
        border-color: color-mix(in srgb, #fbbf24 45%, transparent);
        background: color-mix(in srgb, #fbbf24 7%, transparent);
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
      .pc-learning__starmeta { font-size: 10.5px; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__stargrade.is-ungraded .pc-learning__starmeta { color: var(--fg-mute, #7f9bb4); font-style: italic; }
      .pc-learning__starnote {
        margin-left: auto; padding: 2px 9px; border-radius: 6px; cursor: pointer;
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
        padding: 12px 14px 13px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
      }
      .pc-learning__ideacard-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 22px; }
      .pc-learning__ideacard-head .pc-learning__id {
        display: inline-flex; align-items: center; gap: 5px;
        font-size: 9.5px; font-weight: 720; text-transform: uppercase;
        opacity: 0.9;
      }
      .pc-learning__ideacard-head .pc-learning__sev {
        width: 7px; height: 7px; min-height: 0; border-radius: 50%;
      }
      .pc-learning__ideacard-head .pc-learning__age { font-size: 10px; opacity: 0.85; }
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
