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
} from "@papercusp/operator-core/lib/sync-resolver/learning-scout-read";
import type { HiveLearningsSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-hive-read";
import type { HiveThroughputSnapshot } from "@papercusp/operator-core/lib/sync-resolver/learning-hive-throughput-read";
import type { PotSoakReportSnapshot } from "@papercusp/operator-core/lib/pot/soak-report";
import { BenchmarkTrend, type BenchmarkTrendInstance } from "./BenchmarkTrend";
import type { BakeoffTrendRow } from "@papercusp/operator-core/lib/pot-eval/bakeoff-trend";
import { EkgPanel } from "./EkgPanel";
import { RedQueenPanel } from "./RedQueenPanel";
import { MugWakeEfficiencyPanel } from "./MugWakeEfficiencyPanel";
import { ExperimentsPanel } from "./ExperimentsPanel";
import { Select } from "@/app/harness/Select";
import { Tooltip } from "@/app/harness/Tooltip";
import { Popover } from "@/app/harness/Popover";
import { statusToneColor } from "@/app/harness/theme";
import { useConfirmDialog } from "@/app/harness/useConfirmDialog";
import { usePromptDialog } from "@/app/harness/usePromptDialog";
import { hiveHomeLabel } from "@/lib/hive-label";
import { useLexicon } from "@/lib/useLexicon";
import LearningInfraHealthChip from "./LearningInfraHealthChip";
import LearningEfficacyPanel from "./LearningEfficacyPanel";
import HumanQueueDrain from "./HumanQueueDrain";
import RubricsPanel from "@/app/_components/RubricsPanel";
import RubricDetailPanel from "@/app/_components/RubricDetailPanel";
import ObservationsPanel from "@/app/adv/create/ObservationsPanel";
import {
  LearningComparisonBars,
  LearningDisclosure,
  LearningEvidenceRail,
  LearningHeroMetric,
  LearningPageHeader,
  LearningVisualEmpty,
  LearningVisualStyles,
} from "./LearningVisuals";

const LVIEWS = [
  "observations",
  "rubrics",
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
  "throughput",
  "learnings",
] as const;
type LView = (typeof LVIEWS)[number];

type LearningStage = "observe" | "improve" | "verify" | "retain";
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
      { id: "observations", label: "Observations", icon: Eye },
      { id: "rubrics", label: "Rubrics", icon: Gauge },
    ],
  },
  {
    id: "improve",
    label: "Improve",
    icon: Lightbulb,
    views: [
      { id: "ideas", label: "Ideas", icon: Lightbulb },
      { id: "gym", label: "Gym", icon: Dumbbell },
      { id: "improvements", label: "Improvements", icon: Sparkles },
    ],
  },
  {
    id: "verify",
    label: "Verify",
    icon: Gauge,
    views: [
      { id: "benchmark", label: "Benchmark", icon: FlaskConical },
      { id: "orchestration", label: "Pot orchestration", icon: GitBranch },
      { id: "bakeoff", label: "Framework bake-off", icon: Repeat2 },
      { id: "wake-efficiency", label: "Wake efficiency", icon: Hourglass },
      { id: "ekg", label: "EKG", icon: Activity },
      { id: "red-queen", label: "Red Queen", icon: Radar },
      { id: "experiments", label: "Experiments", icon: Beaker },
    ],
  },
  {
    id: "retain",
    label: "Retain",
    icon: Brain,
    views: [{ id: "learnings", label: "Learnings", icon: Brain }],
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
  const [lview, setLview] = useQueryState(
    "lview",
    parseAsStringEnum<LView>([...LVIEWS]).withDefault("improvements"),
  );
  const [rubricId, setRubricId] = useQueryState("rrubric", parseAsString);
  const [, setGradeDetail] = useQueryState("grade", parseAsString);
  const [, setRetainDetail] = useQueryState("lretain", parseAsString);
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
  const hive = lhive || hives[0]?.slug || "";
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
            value={view}
            onValueChange={(next) => void setLview(next as LView)}
          >
            <Tabs.List
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
                    aria-describedby={
                      status
                        ? `learning-view-status-${candidate.id}`
                        : undefined
                    }
                    title={candidate.label}
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
  rubricId,
  onRubricSelect,
  onStatus,
}: {
  view: LView;
  hive: string;
  rubricId: string | null;
  onRubricSelect: (id: string | null) => void;
  onStatus: (view: LView, status: LearningViewStatus) => void;
}) {
  const reportViewStatus = useCallback(
    (status: LearningViewStatus) => onStatus(view, status),
    [onStatus, view],
  );
  if (view === "observations") {
    return <ObservationsPanel onStatus={reportViewStatus} />;
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
    return <GymView hive={hive} onStatus={reportViewStatus} />;
  }
  if (view === "improvements") {
    return <ImprovementsView hive={hive} onStatus={reportViewStatus} />;
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
  if (view === "throughput") {
    return <ThroughputView onStatus={reportViewStatus} />;
  }
  return <LearningsView hive={hive} onStatus={reportViewStatus} />;
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
  onStatus,
}: {
  hive: string;
  onStatus?: (status: LearningViewStatus) => void;
}) {
  // P-042: the tab-level hive lens scopes the feed to one hive's member-harness
  // improvements; '' ⇒ the workspace-wide feed (no hive arg).
  const sync = useSyncQuery<ImprovementDigest & { flow?: ImprovementFlow }>({
    queryName: "learning.improvements",
    args: hive ? { hive } : {},
    staleTime: 30_000,
  });
  const digest = sync.data?.[0];
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
    if (lane === "auto") return digest.autoEligible;
    if (lane === "human") return digest.humanQueue;
    return [...digest.autoEligible, ...digest.humanQueue];
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
  const autoRows = useMemo(
    () =>
      (digest?.autoEligible ?? []).filter(
        (item) => !src || item.source === src,
      ),
    [digest, src],
  );
  const humanRows = useMemo(
    () =>
      (digest?.humanQueue ?? []).filter((item) => !src || item.source === src),
    [digest, src],
  );
  const sparseRows = useMemo(
    () => [...(digest?.autoEligible ?? []), ...(digest?.humanQueue ?? [])],
    [digest],
  );

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
        title="Improvements"
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
      {showDashboard ? (
        <LearningDisclosure label="Loop diagnostics">
          {digest?.flow ? <FlowStrip flow={digest.flow} /> : null}
          <LearningEfficacyPanel />
        </LearningDisclosure>
      ) : null}

      {digest && showDashboard ? (
        <div className="pc-learning-visual__layout pc-learning-visual__layout--improvements">
          <LearningHeroMetric
            eyebrow="Open"
            value={String(digest.open)}
            status={digest.open === 0 ? "clear" : "active"}
            tone={digest.open === 0 ? "good" : "accent"}
          >
            {resolved} resolved
          </LearningHeroMetric>
          <div
            className="pc-learning__improvementflow"
            aria-label="Improvement routing"
          >
            <span>
              <small>Captured</small>
              <strong>{digest.total}</strong>
            </span>
            <i aria-hidden />
            <span className="is-auto">
              <small>Automatic</small>
              <strong>{digest.autoEligible.length}</strong>
            </span>
            <span className="is-human">
              <small>Review</small>
              <strong>{digest.humanQueue.length}</strong>
            </span>
            <i aria-hidden />
            <span className="is-good">
              <small>Resolved</small>
              <strong>{resolved}</strong>
            </span>
          </div>
          <LearningEvidenceRail>
            <div className="pc-learning-visual__evidence-grid">
              <div className="pc-learning-visual__evidence-metric">
                <span>Automatic</span>
                <strong>{digest.autoEligible.length}</strong>
              </div>
              <div className="pc-learning-visual__evidence-metric">
                <span>Review</span>
                <strong>{digest.humanQueue.length}</strong>
              </div>
            </div>
          </LearningEvidenceRail>
        </div>
      ) : null}

      {/* The owner's drain ritual (consume-edges P-022): top of the human queue
          in the resolver's blocking-impact order; click highlights the row. */}
      {digest && showDashboard && lane !== "auto" ? (
        <HumanQueueDrain
          items={digest.humanQueue}
          onSelect={(id) => void setLsel(id)}
        />
      ) : null}

      {showDashboard ? (
        <div className="pc-learning__sectionhead pc-learning__sectionhead--tools">
          <div className="pc-learning__inlinetools">
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
        <p className="pc-learning__empty">
          Improvements feed unavailable: {sync.error.message}
        </p>
      ) : (showDashboard ? rows : sparseRows).length === 0 ? (
        <LearningVisualEmpty icon={CheckCircle2} title="Nothing in this lane" />
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
      ) : lane === "all" ? (
        <div
          className={`pc-learning__lanegrid${autoRows.length === 0 || humanRows.length === 0 ? " is-single" : ""}`}
        >
          {autoRows.length > 0 ? (
            <section className="pc-learning__lanecol is-auto">
              <header>
                <span>Automatic</span>
                <strong>{autoRows.length}</strong>
              </header>
              <ul className="pc-learning__list">
                {autoRows.map((it) => (
                  <ImprovementRow
                    key={it.id}
                    item={it}
                    selected={it.id === lsel}
                    onDismissSelect={() => void setLsel(null)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {humanRows.length > 0 ? (
            <section className="pc-learning__lanecol is-human">
              <header>
                <span>Review</span>
                <strong>{humanRows.length}</strong>
              </header>
              <ul className="pc-learning__list">
                {humanRows.map((it) => (
                  <ImprovementRow
                    key={it.id}
                    item={it}
                    selected={it.id === lsel}
                    onDismissSelect={() => void setLsel(null)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <ul className="pc-learning__list">
          {rows.map((it) => (
            <ImprovementRow
              key={it.id}
              item={it}
              selected={it.id === lsel}
              onDismissSelect={() => void setLsel(null)}
            />
          ))}
        </ul>
      )}
    </section>
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
interface GymSnapshot {
  proposals: GymProposal[];
  autoloops: GymAutoloop[];
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
  onStatus,
}: {
  hive: string;
  onStatus?: (status: LearningViewStatus) => void;
}) {
  // P-042: scope the gym rollup to one hive's gym harness; '' ⇒ the whole
  // workspace (every gym harness).
  const sync = useSyncQuery<GymSnapshot>({
    queryName: "learning.gym",
    args: hive ? { hive } : {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const proposals = snap?.proposals ?? [];
  const autoloops = snap?.autoloops ?? [];
  const activeAutoloops = autoloops.filter(
    (autoloop) => autoloop.enabled || autoloop.status === "running",
  );

  const champions = proposals.filter((p) => p.status === "accepted").length;
  const pending = proposals.filter((p) => p.status === "pending").length;
  const rejected = proposals.filter((p) => p.status === "rejected").length;
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

      {snap && proposals.length >= 4 ? (
        <div className="pc-learning-visual__layout pc-learning-visual__layout--gym">
          <LearningHeroMetric
            eyebrow="Champions"
            value={String(champions)}
            status={pending > 0 ? `${pending} pending` : "current"}
            tone={champions > 0 ? "good" : "accent"}
          >
            {proposals.length} experiments
          </LearningHeroMetric>
          <div
            className="pc-learning__gymflow"
            aria-label="Gym experiment flow"
          >
            {[
              ["Tested", proposals.length, "accent"],
              ["Pending", pending, "warn"],
              ["Champions", champions, "good"],
            ].map(([label, value, tone], index) => (
              <span key={String(label)} className={`is-${tone}`}>
                <small>{label}</small>
                <strong>{value}</strong>
                {index < 2 ? <i aria-hidden /> : null}
              </span>
            ))}
          </div>
          <LearningEvidenceRail>
            <div className="pc-learning-visual__evidence-grid">
              <div className="pc-learning-visual__evidence-metric">
                <span>Rejected</span>
                <strong>{rejected}</strong>
              </div>
              <div className="pc-learning-visual__evidence-metric">
                <span>Loops</span>
                <strong>{running}</strong>
              </div>
            </div>
          </LearningEvidenceRail>
        </div>
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

      {sync.loading && !snap ? (
        <p className="pc-learning__empty">Loading gym experiments…</p>
      ) : sync.error ? (
        <p className="pc-learning__empty">
          Gym feed unavailable: {sync.error.message}
        </p>
      ) : proposals.length === 0 ? (
        <LearningVisualEmpty icon={Dumbbell} title="No gym experiments" />
      ) : (
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
        signal={
          pending
            ? `${pending.successfulRuns}/${pending.totalRuns} pending`
            : latest
              ? `${latest.successfulRuns}/${latest.totalRuns} solved`
              : undefined
        }
        tone={
          pending
            ? "accent"
            : latest && latest.successRate >= 0.8
              ? "good"
              : "neutral"
        }
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
        <p className="pc-learning__empty">
          Benchmark unavailable: {sync.error.message}
        </p>
      ) : !latest && !pending ? (
        <LearningVisualEmpty icon={Gauge} title="No benchmark runs" />
      ) : (
        <>
          {pending ? (
            <div className="pc-learning__pendingrun" role="status">
              <Clock size={12} aria-hidden />
              <span>
                <strong>{shortSha(pending.codeSha)}</strong> is waiting for a
                scored result
              </span>
              <em>
                {pending.successfulRuns}/{pending.totalRuns} runs complete
              </em>
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
                  {currentDelta != null
                    ? `Δ ${currentDeltaMeta.text}`
                    : "first generation"}
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
        title={`${t("pot")} orchestration`}
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
 * bees-busy-vs-cap, stuck count, mean-time-to-complete, and the question-rung
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

  // Grading (P-006): the note popover's open-state is URL state (`?grade=<ideaId>`)
  // so agents can drive it; in-flight optimistic grades + errors are transient
  // lifecycle → useState. A grade from this surface is an OWNER grade (the
  // server derives gradedBy from the caller — C-3); owner regrade is always
  // allowed, so the stars stay interactive on graded rows.
  const [gradeOpen, setGradeOpen] = useQueryState("grade", parseAsString);
  const [railFilter, setRailFilter] = useQueryState("irail", parseAsString);
  const [showEarlier, setShowEarlier] = useState(false);
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
  const queueItems = showEarlier ? filteredRecent : filteredRecent.slice(0, 8);
  useEffect(() => setShowEarlier(false), [railFilter]);
  useEffect(() => {
    onStatus?.(
      sync.error ? "bad" : snap && snap.totalRouted > 0 ? "good" : "neutral",
    );
  }, [onStatus, snap, sync.error]);

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
  const [, setLane] = useQueryState("lane", parseAsString);
  const [, setSrcSel] = useQueryState("lsrc", parseAsString);
  const [, setLsel] = useQueryState("lsel", parseAsString);
  const openRouted = (item: ScoutRoutedItem) => {
    if (item.rail === "plan" && item.routedRef.startsWith("plan:")) {
      void setPlanSel(item.routedRef.slice("plan:".length));
      void setCreateView("plans");
      void setTab("plans");
    } else if (item.rail === "gym") {
      void setLviewRaw("gym");
    } else if (item.rail === "instance") {
      void setLviewRaw("benchmark");
    } else {
      // improvement (wi:EI-…) and anything unknown → the improvements backlog,
      // selecting THAT row (?lsel) and resetting the lane/source filters so the
      // target is guaranteed visible (a sticky lane=auto would hide a
      // human-tier item and the click would look like a no-op).
      const id = item.routedRef.startsWith("wi:")
        ? item.routedRef.slice("wi:".length)
        : item.routedRef;
      void setLsel(id);
      void setLane(null);
      void setSrcSel(null);
      void setLviewRaw("improvements");
    }
  };

  return (
    <section className="pc-learning__section">
      <LearningPageHeader
        icon={Lightbulb}
        title="Ideas"
        signal={snap ? `${snap.totalRouted} routed` : undefined}
        tone={snap && snap.totalRouted > 0 ? "good" : "neutral"}
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
      <div
        className="pc-learning__flow"
        aria-label={`${t("scout")} tick health`}
      >
        <span
          className="pc-learning__flowchip"
          title={
            tick
              ? `The newest ${t("scout")} tick and its gate outcome.${tick.detail ? ` ${tick.detail}` : ""}`
              : `${t("scout")} records a row per tick (gate outcomes, ideas generated/routed) once tick observability lands — no ticks recorded yet.`
          }
        >
          <Radar size={11} aria-hidden />
          last tick{" "}
          <strong>
            {tick && !Number.isNaN(tickMs) ? whenLabel(tickMs) : "none yet"}
          </strong>
          {tick?.outcome ? (
            <em>
              {tick.detail ? `${tick.outcome} · ${tick.detail}` : tick.outcome}
            </em>
          ) : null}
        </span>
      </div>

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

      {lensEntries.length > 0 ? (
        <LearningDisclosure label="Lens weights" count={lensEntries.length}>
          <div className="pc-learning__flow" aria-label="Lens sampling weights">
            <span
              className="pc-learning__flowchip"
              title={`${t("scout")} picks its creative lenses with these sampling weights — learned from routed-idea outcomes and grades (a ★5 counts as a win, a ★1 as a loss; a grade beats the system's own outcome guess).`}
            >
              <Sparkles size={11} aria-hidden />
              lens weights
            </span>
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
        </LearningDisclosure>
      ) : null}

      <div className="pc-learning__sectionhead">
        <h2>Routed ideas</h2>
      </div>

      {sync.loading && !snap ? (
        <p className="pc-learning__empty">
          Loading the {t("scout", { lower: true })} ledger…
        </p>
      ) : sync.error ? (
        <p className="pc-learning__empty">
          {t("scout")} feed unavailable: {sync.error.message}
        </p>
      ) : filteredRecent.length === 0 ? (
        <LearningVisualEmpty icon={Radar} title={`No routed ideas`} />
      ) : (
        <>
          {gradeError ? (
            <p className="pc-learning__empty" role="alert">
              Grade failed: {gradeError}
            </p>
          ) : null}
          <ul className="pc-learning__list">
            {queueItems.map((item) => {
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
                <li
                  key={item.ideaId}
                  className="pc-learning__row pc-learning__row--scout"
                >
                  <span
                    className="pc-learning__rowmain"
                    role="button"
                    tabIndex={0}
                    onClick={() => openRouted(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openRouted(item);
                      }
                    }}
                    title={`${meta.desc}\n${item.routedRef}`}
                  >
                    <span
                      className="pc-learning__sev"
                      style={{ background: meta.color }}
                      aria-hidden
                    />
                    <span
                      className="pc-learning__id"
                      style={{ color: meta.color }}
                    >
                      {meta.label}
                    </span>
                    <span className="pc-learning__title">
                      {item.title ?? item.routedRef}
                    </span>
                  </span>
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
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
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
                            aria-label={
                              eff ? "Review idea grade" : "Grade this idea"
                            }
                            aria-expanded={isOpen}
                          >
                            {eff ? (
                              <Star size={12} fill="currentColor" aria-hidden />
                            ) : (
                              <MessageSquarePlus size={12} aria-hidden />
                            )}
                          </button>
                        }
                        tooltipLabel={
                          eff ? "Review this grade" : "Grade this idea"
                        }
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
                </li>
              );
            })}
          </ul>
          {filteredRecent.length > 8 ? (
            <button
              type="button"
              className="pc-learning__earlierbtn"
              aria-expanded={showEarlier}
              onClick={() => setShowEarlier((current) => !current)}
            >
              {showEarlier
                ? "Show decision queue only"
                : `Earlier routed ideas · ${filteredRecent.length - 8}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

// ─── Learnings view (a hive's editable shared memory — learning-packs P-008) ──

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
) {
  const source = `${createdBy ?? ""} ${kind ?? ""}`.toLowerCase();
  if (/owner|user|human/.test(source))
    return { Icon: UserRound, tone: "owner", label: "Owner retained" };
  if (/queen|mug|brain/.test(source))
    return { Icon: Brain, tone: "brain", label: "Learning loop retained" };
  if (/scout|idea/.test(source))
    return { Icon: Radar, tone: "scout", label: "Scout retained" };
  if (/migration|system/.test(source))
    return { Icon: ShieldCheck, tone: "system", label: "System retained" };
  if (/reference|project/.test(source))
    return { Icon: BookOpen, tone: "reference", label: "Project reference" };
  return { Icon: Sparkles, tone: "agent", label: "Agent retained" };
}

function LearningsView({
  hive,
  onStatus,
}: {
  hive: string;
  onStatus?: (status: LearningViewStatus) => void;
}) {
  const t = useLexicon();
  const [selectedLearning, setSelectedLearning] = useQueryState(
    "lretain",
    parseAsString,
  );

  const sync = useSyncQuery<HiveLearningsSnapshot>({
    queryName: "learning.hive",
    args: { hive },
    enabled: hive.length > 0,
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const rows = snap?.rows ?? [];
  const filtered = rows;
  const selectedRow = selectedLearning
    ? (filtered.find((row) => row.id === selectedLearning) ?? null)
    : null;
  const selectedProvenance = selectedRow
    ? learningProvenance(selectedRow.createdBy, selectedRow.kind)
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
    const provenance = learningProvenance(r.createdBy, r.kind);
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
        <span
          className="pc-learning__retainedmain"
          role="button"
          tabIndex={0}
          aria-expanded={selected}
          aria-label={`${selected ? "Close" : "Open"} learning ${preview.headline}`}
          onClick={() => void setSelectedLearning(selected ? null : r.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void setSelectedLearning(selected ? null : r.id);
            }
          }}
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
        </span>
      </li>
    );
  };

  return (
    <>
      {confirmEl}
      {promptEl}
      <section className="pc-learning__section">
        <LearningPageHeader
          icon={Brain}
          title="Shared learnings"
          signal={snap ? `${rows.length} retained` : undefined}
          tone={rows.length > 0 ? "good" : "neutral"}
          action={
            <button
              type="button"
              className="pc-learning__refresh"
              aria-label="Reload the learnings"
              disabled={sync.fetching}
              onClick={() => sync.invalidate()}
            >
              <RefreshCw size={13} aria-hidden />
            </button>
          }
        />

        {rows.length > 0 ? (
          <div className="pc-learning__sectionhead">
            <h2>Shared memory</h2>
          </div>
        ) : null}

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
          <p className="pc-learning__quietempty">
            Memory store unavailable — try reloading.
          </p>
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
                {filtered.slice(0, 6).map(renderLearning)}
              </ul>
              {filtered.length > 6 ? (
                <LearningDisclosure
                  label="Earlier retained learnings"
                  count={filtered.length - 6}
                >
                  <ul className="pc-learning__list">
                    {filtered.slice(6).map(renderLearning)}
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
        display: grid; grid-template-columns: repeat(4, minmax(90px, 1fr));
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
      .pc-learning__view-list { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; padding: 0; overflow-x: auto; scrollbar-width: thin; border-bottom: 1px solid var(--border); background: transparent; }
      .pc-learning__view-tab {
        display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; padding: 5px 9px 6px;
        border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent;
        color: var(--fg-mute); cursor: pointer; font: inherit; font-size: 11.5px; font-weight: 620;
        transition: color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast);
      }
      .pc-learning__view-icon { position: relative; display: grid; place-items: center; width: 18px; height: 18px; flex: none; border: 1px solid transparent; border-radius: 50%; }
      .pc-learning__view-icon .pc-learning__statusmark { right: -3px; bottom: -3px; width: 6px; height: 6px; border-width: 1.5px; }
      .pc-learning__view-tab:hover { color: var(--fg); background: color-mix(in srgb, var(--accent) 5%, transparent); }
      .pc-learning__view-tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }

      .pc-learning__hivepick {
        display: inline-flex; align-items: center; gap: 6px;
        margin-left: auto;
        padding: 5px 10px; font-size: 11.5px; font-weight: 600; border-radius: 999px;
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
      @container learning (max-width: 1100px) {
        .pc-learning__view-tabs[data-stage="verify"] .pc-learning__view-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .pc-learning__view-tabs[data-stage="verify"] .pc-learning__view-tab[aria-selected="true"] .pc-learning__view-label { position: static; width: auto; height: auto; overflow: visible; clip-path: none; white-space: nowrap; }
        .pc-learning__view-tabs[data-stage="verify"] .pc-learning__view-tab { padding-inline: 7px; }
        .pc-learning__view-tabs[data-stage="verify"] .pc-learning__view-icon { width: 22px; height: 22px; }
      }
      @container learning (max-width: 560px) {
        .pc-learning { padding-inline: 9px; }
        .pc-learning__stage-list { grid-template-columns: repeat(4, minmax(44px, 1fr)); }
        .pc-learning__stage-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .pc-learning__controls { flex-wrap: nowrap; }
        .pc-learning__view-tabs { flex: 1 1 auto; overflow: hidden; }
        .pc-learning__hivepicklabel { display: none; }
      }

      /* Flow strip (P-041) — compact in/out chips above the stock scoreboard. */
      .pc-learning__flow { display: flex; flex-wrap: wrap; gap: 6px; }
      .pc-learning__flowchip {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__flowchip strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__flowchip em { font-style: normal; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
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
      .pc-learning__sectionhead--tools { justify-content: flex-end; min-height: 28px; }
      .pc-learning__sectionhead h2 { margin: 0; font-size: 13px; font-weight: 720; text-transform: uppercase; letter-spacing: 0; color: var(--fg-dim, #b9d4e8); }
      .pc-learning__inlinetools { display: inline-flex; align-items: center; gap: 8px; }
      .pc-learning__lanes { display: inline-flex; gap: 4px; }
      .pc-learning__lane {
        padding: 4px 10px; font-size: 11px; font-weight: 650; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: transparent; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__lane.is-active { color: var(--fg, #e7f7ff); border-color: rgba(125, 211, 252, 0.5); background: rgba(125, 211, 252, 0.12); }
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
      .pc-learning__rowmain { display: grid; grid-template-columns: 4px auto minmax(0, 1fr); align-items: center; gap: 9px; min-width: 0; cursor: pointer; border-radius: 6px; }
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
      .pc-learning__earlierbtn { align-self: center; padding: 5px 10px; border: 0; background: transparent; color: var(--fg-mute); font: inherit; font-size: 10.5px; cursor: pointer; }
      .pc-learning__earlierbtn:hover { color: var(--accent); }

      .pc-learning__row--retained { grid-template-columns: 4px minmax(0, 1fr) auto; }
      .pc-learning__row--retained.is-selected { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
      .pc-learning__retainedmain { min-width: 0; cursor: pointer; border-radius: 5px; }
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
      @container learning (max-width: 820px) { .pc-learning__retainlayout.has-detail { grid-template-columns: 1fr; } .pc-learning__retaindetail { grid-row: 1; } }

      /* Lens sampling weights (P-007 steering visibility). */
      .pc-learning__lens { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4); }
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
      .pc-learning__provenance { display: inline-grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 50%; color: var(--fg-mute); }
      .pc-learning__provenance.is-owner { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); }
      .pc-learning__provenance.is-brain { color: #34d399; border-color: color-mix(in srgb, #34d399 42%, var(--border)); }
      .pc-learning__provenance.is-scout { color: #a78bfa; border-color: color-mix(in srgb, #a78bfa 42%, var(--border)); }
      .pc-learning__provenance.is-system { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 42%, var(--border)); }
      .pc-learning__provenance.is-reference { color: #38bdf8; border-color: color-mix(in srgb, #38bdf8 42%, var(--border)); }
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
