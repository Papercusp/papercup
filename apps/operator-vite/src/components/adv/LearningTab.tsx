/**
 * LearningTab — the /adv "Learning" tab (operator-learning-tab-2026-06-09).
 *
 * A PULL surface for everything the system learns about itself. It replaces the
 * old `improvement-digest` inbox PUSH notification (a dead-end the owner couldn't
 * click through, D-001): instead of being pinged, the owner opens this tab.
 *
 * Sub-views (nuqs `?lview=`):
 *   - **Improvements** (default): the captured `papercusp-improvement` backlog, read
 *     through the `learning.improvements` resolver (same readImprovementItems +
 *     buildDigest path the `improvements:digest` tool uses, D-003). Scoreboard +
 *     the two triage lanes (auto-fixable vs needs-review).
 *   - **Gym**: the prompt-optimization pipeline — recent proposals (pending /
 *     accepted=champions / rejected) + each gym harness's autoloop status, read
 *     through `learning.gym` (the gym control-plane readers).
 *   - **Benchmark**: the apiary / IQ-battery generation trend via `learning.apiary`
 *     (owner-gated gen-0 baseline → clean empty state until it runs).
 *   - **Scout**: routed-ideas-by-rail + last-tick gate outcome via `learning.scout`
 *     (graceful empty until Scout routes its first idea / P-034 ticks land), plus
 *     idea grading (scout-idea-grading-2026-06-12 B-07): a 1–5 star control and
 *     note popover (`?grade=<ideaId>`) writing through the `scout:grade-idea`
 *     tool proxy with optimistic updates, a grade chip with owner/Queen
 *     attribution, and the learned per-lens sampling weights.
 *   - **Knowledge**: agent-insight runbook count + recent-5 and a memory-health
 *     strip via `learning.knowledge`, cross-linking to the full Insights tab
 *     (`?tab=insights`) — a teaser, never a duplicate of that tab.
 *
 * Each sub-view carries a plain-language "how this works" step strip (nuqs `?how=`,
 * shown by default) so the tab explains itself; every stat and chip carries a hover
 * hint.
 *
 * Per-Hive lens (per-hive-learning-loops-2026-06-14 P-042, D-008 — the Hive is the
 * tenancy unit): a tab-level `?lhive=` param + a header hive dropdown scope the
 * HIVE-AWARE views (Improvements, Gym, Learnings) to one hive. The workspace-global
 * views (Benchmark, Scout, Knowledge — and the EKG/RedQueen/scout-ledger panels) and
 * Throughput (already all-hives) ignore it; the picker hides on those.
 *
 * All user-meaningful state is in the URL via nuqs (CLAUDE.md). Styled with the
 * shared app tokens (--fg/--accent/…), matching AdvShell + AdvConversationsTab.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsStringEnum, parseAsBoolean, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { GraduationCap, RefreshCw, ShieldCheck, UserRound, CheckCircle2, Dumbbell, Sparkles, XCircle, Clock, HelpCircle, Gauge, BookOpen, ArrowUpRight, ArrowUp, ArrowDown, Minus, Activity, Repeat2, Hourglass, Radar, Brain, Star, MessageSquarePlus, MessageSquareText, Send } from 'lucide-react';
import type { ImprovementDigest, ScoredItem } from '@papercusp/operator-core/lib/harness/improvements/digest';
import type { ImprovementFlow } from '@papercusp/operator-core/lib/harness/improvements/flow-metrics';
import type { InsightsSnapshot, MemoryHealth } from '@papercusp/operator-core/lib/memory/knowledge-read';
import type { ScoutSnapshot, ScoutRoutedItem } from '@papercusp/operator-core/lib/sync-resolver/learning-scout-read';
import type { HiveLearningsSnapshot } from '@papercusp/operator-core/lib/sync-resolver/learning-hive-read';
import type { HiveThroughputSnapshot } from '@papercusp/operator-core/lib/sync-resolver/learning-hive-throughput-read';
import type { InstallAction, InstallReview } from '@papercusp/operator-core/lib/learning-packs/manage';
import { BenchmarkTrend, type BenchmarkTrendInstance } from './BenchmarkTrend';
import type { BakeoffTrendRow } from '@papercusp/operator-core/lib/hive-eval/bakeoff-trend';
import { EkgPanel } from './EkgPanel';
import { RedQueenPanel } from './RedQueenPanel';
import { QueenWakeEfficiencyPanel } from './QueenWakeEfficiencyPanel';
import { DemandPanel } from './DemandPanel';
import { ExperimentsPanel } from './ExperimentsPanel';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { usePromptDialog } from '@/app/harness/usePromptDialog';
import { hiveHomeLabel } from '@/lib/hive-label';
import LearningInfraHealthChip from './LearningInfraHealthChip';
import MemoryHealthCard from './MemoryHealthCard';
import LearningEfficacyPanel from './LearningEfficacyPanel';
import HumanQueueDrain from './HumanQueueDrain';
import LearningPackCandidates from './LearningPackCandidates';

const LVIEWS = ['improvements', 'gym', 'benchmark', 'scout', 'throughput', 'knowledge', 'learnings'] as const;
type LView = (typeof LVIEWS)[number];

/** The plain-language pipeline behind each sub-view, rendered as the "how this works" strip. */
const HOW_STEPS: Record<LView, { title: string; desc: string }[]> = {
  improvements: [
    {
      title: 'Notice',
      desc: 'A background watchdog files objective problems (failing tests, broken tools, down services), and agents file friction they hit while working.',
    },
    {
      title: 'Triage',
      desc: 'Every item is scored by severity and age, then sorted: safe bug-fixes go to the auto-fixable lane; anything risky or judgment-shaped waits for your review.',
    },
    {
      title: 'Resolve',
      desc: 'Fixes land and items close. A problem that comes back is re-filed and climbs the queue.',
    },
  ],
  gym: [
    {
      title: 'Experiment',
      desc: 'The gym rewrites one agent role’s prompt and proposes the variant as a candidate.',
    },
    {
      title: 'Score',
      desc: 'A frozen judge benchmarks the variant against the current prompt — Δ is the score change, positive means better.',
    },
    {
      title: 'Promote',
      desc: 'Winners are accepted as champions and become the role’s live prompt; losers are rejected.',
    },
  ],
  benchmark: [
    {
      title: 'Run',
      desc: 'A fixed battery of coding tasks is run against the agent fleet — the same tasks every time, so generations are comparable.',
    },
    {
      title: 'Score',
      desc: 'A frozen judge grades each run, and we record the composite score, time-to-green, tokens, and how often a human was needed.',
    },
    {
      title: 'Track',
      desc: 'Each run becomes one point on the trend. Rising scores (and falling time/tokens/escalations) are the proof the improvements and the gym are actually working.',
    },
  ],
  scout: [
    {
      title: 'Watch',
      desc: 'On a cadence, Scout sweeps the system through creative lenses, hunting for patterns and improvement ideas the day-to-day loop misses.',
    },
    {
      title: 'Gate',
      desc: 'Each tick passes gates (idle, friction, budget, circuit-breaker) before spending anything — most ticks correctly decide to do nothing.',
    },
    {
      title: 'Route',
      desc: 'Ideas that survive critique are routed into a rail — a plan draft, a gym experiment, or a work item — and their outcomes feed back into which lenses get used.',
    },
    {
      title: 'Grade',
      desc: 'Grade routed ideas 1–5 with an optional note — the Queen auto-grades the rest, and your grade always wins. Grades shift the lens weights below, and recent notes are quoted to the next cycle’s ideators.',
    },
  ],
  throughput: [
    {
      title: 'Place',
      desc: 'The Queen ranks the ready work and fans it onto bees — as many per wake as there are free slots. Frontier depth is how much waits; placements/wake is how fast she pours.',
    },
    {
      title: 'Run',
      desc: 'Each placed bee runs to completion. Busy-vs-cap is fleet utilization, mean-time-to-complete is how long a placement takes, and a stuck count flags bees that stopped advancing.',
    },
    {
      title: 'Unblock',
      desc: 'When a bee hits a question, where it resolves — itself, a peer vote, the Queen, or you — is the question-rung split. A loop operating well keeps the frontier draining without pegging the fleet or stranding placements.',
    },
  ],
  knowledge: [
    {
      title: 'Hit something non-obvious',
      desc: 'When an agent works through a confusing failure or a subtle invariant, it writes a short runbook so the next agent doesn’t lose the same hour.',
    },
    {
      title: 'Review',
      desc: 'Those insights are PR-reviewed docs — durable, searchable knowledge, not chat that scrolls away.',
    },
    {
      title: 'Reuse',
      desc: 'The fleet reads them before grepping code. Open the Insights tab to browse the full library.',
    },
  ],
  learnings: [
    {
      title: 'Seeded',
      desc: 'A new hive starts with a learning pack — curated working wisdom copied into its shared memory, badged so you can always tell it apart from what the hive learned itself.',
    },
    {
      title: 'Grown',
      desc: 'Agents bind the pack’s discovery rules to your project (the test command, the design system) and record their own conventions into the same pool.',
    },
    {
      title: 'Yours to edit',
      desc: 'Everything here is editable — fix a learning that doesn’t fit your project, remove what you disagree with, add what’s missing. Agents treat the pool as strong defaults, not gospel.',
    },
  ],
};

/** Sub-views whose data is scoped to ONE Hive (the tenancy unit, D-008) — they
 *  read the tab-level `?lhive=`. The rest are workspace-global (Benchmark,
 *  Scout, Knowledge — plus the EKG/RedQueen/scout-ledger panels inside them) and
 *  ignore it; Throughput already lists every hive, so it ignores it too. */
const HIVE_AWARE_VIEWS: ReadonlySet<LView> = new Set<LView>(['improvements', 'gym', 'learnings']);

export default function LearningTab() {
  const [lview, setLview] = useQueryState('lview', parseAsStringEnum<LView>([...LVIEWS]).withDefault('improvements'));
  const [showHow, setShowHow] = useQueryState('how', parseAsBoolean.withDefault(true));
  // Tab-level per-Hive lens (per-hive-learning-loops P-042): ONE `?lhive=` param,
  // promoted up from the Learnings sub-view so it applies across every hive-aware
  // view. Agents drive it via ui:dispatch; the hive-creation success card
  // deep-links here with ?lhive=<slug>. Default '' ⇒ the first hive (resolved
  // once the list loads).
  const [lhive, setLhive] = useQueryState('lhive', parseAsString.withDefault(''));
  const view: LView = (LVIEWS as readonly string[]).includes(lview) ? (lview as LView) : 'improvements';

  // The workspace's hives back the header picker (reuses the Learnings view's
  // query). Only fetched/shown for hive-aware views; an empty selection falls
  // back to the first hive so a fresh tab lands on a real hive.
  const hiveList = useSyncQuery<{ slug: string; remote: boolean }>({
    queryName: 'learning.hiveList',
    args: {},
    staleTime: 60_000,
    enabled: HIVE_AWARE_VIEWS.has(view),
  });
  const hives = hiveList.data ?? [];
  const hiveAware = HIVE_AWARE_VIEWS.has(view);
  const hive = lhive || hives[0]?.slug || '';

  return (
    <div className="pc-learning">
      <header className="pc-learning__header">
        <div className="pc-learning__copy">
          <h1>
            <GraduationCap size={18} aria-hidden /> Learning
          </h1>
          <p>
            Papercusp improves itself while it works. Problems and ideas it notices are filed here as improvements — safe
            fixes are handled automatically, the rest wait for your review — and the gym tunes the agents’ own prompts
            through scored experiments.
          </p>
        </div>
        <LearningInfraHealthChip />
      </header>

      <div className="pc-learning__controls">
        <div className="pc-learning__subnav" role="tablist" aria-label="Learning view">
          <button
            type="button"
            role="tab"
            aria-selected={lview === 'improvements'}
            className={`pc-learning__subtab${lview === 'improvements' ? ' is-active' : ''}`}
            onClick={() => void setLview('improvements')}
          >
            <Sparkles size={13} aria-hidden />
            <span>Improvements<em>problems & fixes</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lview === 'gym'}
            className={`pc-learning__subtab${lview === 'gym' ? ' is-active' : ''}`}
            onClick={() => void setLview('gym')}
          >
            <Dumbbell size={13} aria-hidden />
            <span>Gym<em>prompt tuning</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lview === 'benchmark'}
            className={`pc-learning__subtab${lview === 'benchmark' ? ' is-active' : ''}`}
            onClick={() => void setLview('benchmark')}
          >
            <Gauge size={13} aria-hidden />
            <span>Benchmark<em>getting better?</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lview === 'scout'}
            className={`pc-learning__subtab${lview === 'scout' ? ' is-active' : ''}`}
            onClick={() => void setLview('scout')}
          >
            <Radar size={13} aria-hidden />
            <span>Scout<em>idea radar</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lview === 'throughput'}
            className={`pc-learning__subtab${lview === 'throughput' ? ' is-active' : ''}`}
            onClick={() => void setLview('throughput')}
          >
            <Activity size={13} aria-hidden />
            <span>Throughput<em>queen loop</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lview === 'knowledge'}
            className={`pc-learning__subtab${lview === 'knowledge' ? ' is-active' : ''}`}
            onClick={() => void setLview('knowledge')}
          >
            <BookOpen size={13} aria-hidden />
            <span>Knowledge<em>agent insights</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lview === 'learnings'}
            className={`pc-learning__subtab${lview === 'learnings' ? ' is-active' : ''}`}
            onClick={() => void setLview('learnings')}
          >
            <Brain size={13} aria-hidden />
            <span>Learnings<em>hive memory</em></span>
          </button>
        </div>
        <div className="pc-learning__controlsright">
          {/* Tab-level per-Hive lens (P-042). Hive-aware views read it; the
              workspace-global views (Benchmark / Scout / Knowledge / Throughput)
              hide the picker since they ignore it. */}
          {hiveAware ? (
            <Tooltip label="Scope the hive-aware views (Improvements, Gym, Learnings) to one hive — the tenancy unit. Benchmark, Scout, Knowledge and Throughput are workspace-wide and ignore this.">
              <label className="pc-learning__hivepick">
                <Brain size={12} aria-hidden />
                <span className="pc-learning__hivepicklabel">hive</span>
                <Select
                  ariaLabel="Hive lens"
                  value={hive}
                  onChange={(v: string) => void setLhive(v)}
                  disabled={hives.length === 0}
                  placeholder={hives.length === 0 ? 'no hives yet' : undefined}
                  triggerStyle={{ maxWidth: 200, opacity: hives.length === 0 ? 0.6 : undefined }}
                  options={hives.map((h) => ({
                    value: h.slug,
                    label: `${hiveHomeLabel(h.slug)}${h.remote ? ' (joined)' : ''}`,
                  }))}
                />
              </label>
            </Tooltip>
          ) : null}
          <button
            type="button"
            className={`pc-learning__howtoggle${showHow ? ' is-on' : ''}`}
            aria-expanded={!!showHow}
            onClick={() => void setShowHow(!showHow)}
          >
            <HelpCircle size={13} aria-hidden />
            How this works
          </button>
        </div>
      </div>

      {showHow ? (
        <ol className="pc-learning__how" aria-label="How this works">
          {HOW_STEPS[view].map((s, i) => (
            <li key={s.title} className="pc-learning__howstep">
              <span className="pc-learning__hownum" aria-hidden>{i + 1}</span>
              <span className="pc-learning__howbody">
                <strong>{s.title}</strong>
                <em>{s.desc}</em>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {view === 'gym' ? (
        <GymView hive={hive} />
      ) : view === 'benchmark' ? (
        <ApiaryView />
      ) : view === 'scout' ? (
        <ScoutView />
      ) : view === 'throughput' ? (
        <ThroughputView />
      ) : view === 'knowledge' ? (
        <KnowledgeView />
      ) : view === 'learnings' ? (
        <LearningsView hive={hive} />
      ) : (
        <ImprovementsView hive={hive} />
      )}

      <p className="pc-learning__footnote">
        Improvements fix problems, the gym tunes the agents, the benchmark checks whether it’s all working, and Scout hunts for ideas — captured knowledge lives in Knowledge / Insights, and each hive’s editable memory lives in Learnings.
      </p>

      <LearningStyles />
    </div>
  );
}

// ─── Improvements view ───────────────────────────────────────────────────────

const LANES = ['all', 'auto', 'human'] as const;
type Lane = (typeof LANES)[number];

/** Severity → accent. Tokenized to the app's semantic palette so severity reads
 *  the same here as in the sibling issue panels (RealIssuesPanel/PinnedIssuePanel):
 *  critical=danger, minor=warn, nit=muted. `major` stays a hardcoded orange — there
 *  is no semantic orange token, and every severity panel hardcodes it. Hardcoded
 *  semantic chip colors alongside the CSS-var tokens are the established idiom
 *  (apps/operator/app/harness/TrustBadge.tsx). */
const SEV_COLOR: Record<string, string> = {
  critical: 'var(--bad)',
  major: '#fb923c',
  minor: 'var(--warn)',
  nit: 'var(--fg-mute)',
};

function ageLabel(days: number): string {
  if (days < 1 / 24) return 'just now';
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

function ImprovementsView({ hive }: { hive: string }) {
  // P-042: the tab-level hive lens scopes the feed to one hive's member-harness
  // improvements; '' ⇒ the workspace-wide feed (no hive arg).
  const sync = useSyncQuery<ImprovementDigest & { flow?: ImprovementFlow }>({
    queryName: 'learning.improvements',
    args: hive ? { hive } : {},
    staleTime: 30_000,
  });
  const digest = sync.data?.[0];
  const [lane, setLane] = useQueryState('lane', parseAsStringEnum<Lane>([...LANES]).withDefault('all'));
  // Source facet (`?lsrc=`): who filed it — Scout / Queen / system / … (payload.sourceRole).
  const [src, setSrc] = useQueryState('lsrc', parseAsString);
  // Selected item (`?lsel=`): set by deep-links (e.g. a Scout-routed improvement
  // click) — the row is highlighted + scrolled into view; clicking it dismisses.
  const [lsel, setLsel] = useQueryState('lsel', parseAsString);

  const allRows = useMemo<ScoredItem[]>(() => {
    if (!digest) return [];
    if (lane === 'auto') return digest.autoEligible;
    if (lane === 'human') return digest.humanQueue;
    return [...digest.autoEligible, ...digest.humanQueue];
  }, [digest, lane]);

  const sources = useMemo<string[]>(() => {
    const s = new Set<string>();
    for (const it of [...(digest?.autoEligible ?? []), ...(digest?.humanQueue ?? [])]) {
      if (it.source) s.add(it.source);
    }
    return [...s].sort();
  }, [digest]);

  const rows = useMemo<ScoredItem[]>(
    () => (src ? allRows.filter((it) => it.source === src) : allRows),
    [allRows, src],
  );

  const resolved = digest?.byState?.resolved ?? 0;

  return (
    <section className="pc-learning__section">
      {digest?.flow ? <FlowStrip flow={digest.flow} /> : null}
      <LearningEfficacyPanel />

      <div className="pc-learning__scoreboard" aria-label="Improvements summary">
        <Stat label="captured" value={digest?.total ?? '—'} hint="Everything ever filed — problems, friction, and ideas, open or not." />
        <Stat label="open" value={digest?.open ?? '—'} hint="Not fixed yet." />
        <Stat label="auto-fixable" value={digest?.autoEligible.length ?? '—'} tone="auto" hint="Open bugs that touch no protected surface — agents may fix these without asking you." />
        <Stat label="needs review" value={digest?.humanQueue.length ?? '—'} tone="human" hint="Open items that need your judgment — risky surfaces, behaviour changes, or new features." />
        <Stat label="resolved" value={resolved} tone="good" hint="Fixed and closed." />
      </div>

      {/* The owner's drain ritual (consume-edges P-022): top of the human queue
          in the resolver's blocking-impact order; click highlights the row. */}
      {digest && lane !== 'auto' ? (
        <HumanQueueDrain items={digest.humanQueue} onSelect={(id) => void setLsel(id)} />
      ) : null}

      <div className="pc-learning__sectionhead">
        <h2>Captured improvements</h2>
        <div className="pc-learning__inlinetools">
          {sources.length > 0 ? (
            <Select
              ariaLabel="Filter by who filed it"
              value={src ?? '__any__'}
              onChange={(v: string) => void setSrc(v === '__any__' ? null : v)}
              options={[
                { value: '__any__', label: 'Any source' },
                ...sources.map((s) => ({ value: s, label: s })),
              ]}
            />
          ) : null}
          <div className="pc-learning__lanes" role="tablist" aria-label="Triage lane">
            {LANES.map((l) => (
              <Tooltip
                key={l}
                label={l === 'auto' ? 'Bugs agents may fix on their own' : l === 'human' ? 'Items waiting on your judgment' : null}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={lane === l}
                  className={`pc-learning__lane${lane === l ? ' is-active' : ''}`}
                  onClick={() => void setLane(l)}
                >
                  {l === 'all' ? 'All' : l === 'auto' ? 'Auto-fixable' : 'Needs review'}
                </button>
              </Tooltip>
            ))}
          </div>
          <button
            type="button"
            className="pc-learning__refresh"
            aria-label="Reload the improvements feed"
            disabled={sync.fetching}
            onClick={() => sync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        </div>
      </div>

      {sync.loading && !digest ? (
        <p className="pc-learning__empty">Loading the improvements backlog…</p>
      ) : sync.error ? (
        <p className="pc-learning__empty">Improvements feed unavailable: {sync.error.message}</p>
      ) : rows.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <CheckCircle2 size={20} aria-hidden />
          <strong>Nothing in this lane</strong>
          <span>The watchdog auto-files objective signals (failing tests, down services, repeated tool errors) and agents capture friction as they work — they’ll appear here.</span>
        </div>
      ) : (
        <ul className="pc-learning__list">
          {rows.map((it) => (
            <ImprovementRow key={it.id} item={it} selected={it.id === lsel} onDismissSelect={() => void setLsel(null)} />
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
  const sevColor = SEV_COLOR[item.severity ?? 'minor'] ?? 'var(--fg-mute)';
  const human = item.tier === 'human';
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [selected]);
  return (
    <li
      ref={ref}
      className={`pc-learning__row${selected ? ' pc-learning__row--selected' : ''}`}
      title={item.tierReason}
      onClick={selected ? onDismissSelect : undefined}
    >
      <span className="pc-learning__sev" style={{ background: sevColor }} aria-hidden />
      <span className="pc-learning__id">{item.id}</span>
      <span className="pc-learning__title">{item.title}</span>
      <span className="pc-learning__meta">
        <span className="pc-learning__chip" style={{ color: sevColor, borderColor: sevColor }}>
          {item.severity ?? '—'}
        </span>
        {item.ideaType ? <span className="pc-learning__chip pc-learning__chip--idea">{item.ideaType}</span> : null}
        {item.source ? (
          <span className="pc-learning__chip" title={`Filed by ${item.source}`}>
            {item.source}
          </span>
        ) : null}
        <span
          className={`pc-learning__chip pc-learning__chip--${human ? 'human' : 'auto'}`}
          title={human ? 'Waits for your review' : 'An agent may fix this on its own'}
        >
          {human ? <UserRound size={10} aria-hidden /> : <ShieldCheck size={10} aria-hidden />}
          {human ? 'review' : 'auto'}
        </span>
        <span className="pc-learning__age" title="How long ago this was filed">{ageLabel(item.ageDays)}</span>
        <span className="pc-learning__score" title="Triage priority (severity + age) — higher means more urgent">{item.score}</span>
      </span>
    </li>
  );
}

// ─── Flow strip (P-041 — flows, not stocks) ──────────────────────────────────

/** Watchdog liveness tone: green <30min since the last tick, amber <2h, red otherwise (incl. never). */
function watchdogHealth(lastTickAt: string | null, nowMs: number): { tone: 'good' | 'warn' | 'bad'; label: string } {
  const ms = lastTickAt ? Date.parse(lastTickAt) : NaN;
  if (Number.isNaN(ms)) return { tone: 'bad', label: 'never' };
  const ageMin = Math.max(0, (nowMs - ms) / 60_000);
  const label = ageMin < 1 ? 'just now' : ageMin < 90 ? `${Math.round(ageMin)}m ago` : ageMin < 48 * 60 ? `${Math.round(ageMin / 60)}h ago` : `${Math.round(ageMin / (60 * 24))}d ago`;
  if (ageMin < 30) return { tone: 'good', label };
  if (ageMin < 120) return { tone: 'warn', label };
  return { tone: 'bad', label };
}

/** The flow scoreboard — is the loop CYCLING (in vs out), not just how big the pile is. */
function FlowStrip({ flow }: { flow: ImprovementFlow }) {
  const net = flow.net7d;
  const netTone: 'good' | 'warn' | 'flat' = net < 0 ? 'good' : net > 0 ? 'warn' : 'flat';
  const wd = watchdogHealth(flow.watchdog.lastTickAt, Date.now());
  return (
    <div className="pc-learning__flow" aria-label="Improvement flow (trailing window)">
      <span
        className="pc-learning__flowchip"
        title="Items captured vs resolved in the trailing 7 days — the loop's in-flow vs out-flow. A shrinking backlog (↓) means resolution is keeping up with capture."
      >
        <Activity size={11} aria-hidden />
        <strong>{flow.captured7d}</strong> in / <strong>{flow.resolved7d}</strong> out
        <em>7d</em>
        <span className={`pc-learning__flownet pc-learning__flownet--${netTone}`} title="Net backlog change over 7 days (captured − resolved)">
          {net > 0 ? <ArrowUp size={10} aria-hidden /> : net < 0 ? <ArrowDown size={10} aria-hidden /> : <Minus size={10} aria-hidden />}
          {net > 0 ? `+${net}` : net}
        </span>
      </span>
      <span
        className="pc-learning__flowchip"
        title="Median age of the open items — fresh churn or sediment? Rising median = the backlog is silting up."
      >
        <Hourglass size={11} aria-hidden />
        median open <strong>{flow.medianOpenAgeDays == null ? '—' : ageLabel(flow.medianOpenAgeDays)}</strong>
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
        <span className={`pc-learning__flowdot pc-learning__flowdot--${wd.tone}`} aria-hidden />
        watchdog <strong>{wd.label}</strong>
        <em>{flow.watchdog.ticks24h} ticks / {flow.watchdog.captured24h} captured · 24h</em>
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
function DispatchChip({ d }: { d: NonNullable<ImprovementFlow['dispatch']> }) {
  const dead = d.overdue + d.fireFailed + d.orphaned;
  const tone: 'good' | 'warn' | 'bad' = dead > 0 ? 'bad' : d.fixed7d > 0 ? 'good' : 'warn';
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
      dispatch <strong>{d.fired7d}</strong> fired / <strong>{d.fixed7d}</strong> fixed
      <em>7d</em>
      {dead > 0 ? <strong>{dead} dead</strong> : <em>{d.inProgress + d.firing} live</em>}
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

const GYM_STATUS_COLOR: Record<string, string> = {
  accepted: 'var(--good)',
  pending: 'var(--warn)',
  rejected: 'var(--bad)',
  superseded: 'var(--fg-mute)',
};

function whenLabel(ms: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function deltaLabel(d: number | null): { text: string; tone: 'good' | 'bad' | 'flat' } {
  if (d === null || d === undefined || Number.isNaN(d)) return { text: '—', tone: 'flat' };
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  return { text: `${sign}${Math.abs(d).toFixed(3)}`, tone: d > 0 ? 'good' : d < 0 ? 'bad' : 'flat' };
}

function GymView({ hive }: { hive: string }) {
  // P-042: scope the gym rollup to one hive's gym harness; '' ⇒ the whole
  // workspace (every gym harness).
  const sync = useSyncQuery<GymSnapshot>({
    queryName: 'learning.gym',
    args: hive ? { hive } : {},
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const proposals = snap?.proposals ?? [];
  const autoloops = snap?.autoloops ?? [];

  const champions = proposals.filter((p) => p.status === 'accepted').length;
  const pending = proposals.filter((p) => p.status === 'pending').length;
  const rejected = proposals.filter((p) => p.status === 'rejected').length;
  const running = autoloops.filter((a) => a.enabled || a.status === 'running').length;

  return (
    <section className="pc-learning__section">
      <div className="pc-learning__scoreboard" aria-label="Gym summary">
        <Stat label="experiments" value={snap ? proposals.length : '—'} hint="Prompt variants the gym has proposed and tested recently." />
        <Stat label="champions" value={snap ? champions : '—'} tone="good" hint="Accepted variants — each is now its role’s live prompt." />
        <Stat label="pending" value={snap ? pending : '—'} tone="human" hint="Scored, awaiting a decision." />
        <Stat label="rejected" value={snap ? rejected : '—'} hint="Scored worse than the current prompt — discarded." />
        <Stat label="active loops" value={snap ? running : '—'} tone="auto" hint="Gym harnesses set to keep running experiment cycles on their own, within a spend budget." />
      </div>

      <div className="pc-learning__sectionhead">
        <h2>Prompt experiments</h2>
        <button
          type="button"
          className="pc-learning__refresh"
          aria-label="Reload the gym feed"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {autoloops.length > 0 && (
        <div className="pc-learning__loops" aria-label="Gym autoloops">
          {autoloops.map((a) => (
            <span
              key={a.harnessSlug}
              className={`pc-learning__loop pc-learning__loop--${a.status}`}
              title={`This gym runs experiment cycles on its own${a.budgetUsd != null ? ` — $${a.spentUsd.toFixed(2)} spent of a $${a.budgetUsd.toFixed(0)} budget` : ''}`}
            >
              <Dumbbell size={11} aria-hidden />
              {a.harnessSlug}
              <em>{a.enabled ? a.status : 'off'}</em>
              {a.budgetUsd != null && <span className="pc-learning__loopspend">${a.spentUsd.toFixed(2)}/${a.budgetUsd.toFixed(0)}</span>}
            </span>
          ))}
        </div>
      )}

      {sync.loading && !snap ? (
        <p className="pc-learning__empty">Loading gym experiments…</p>
      ) : sync.error ? (
        <p className="pc-learning__empty">Gym feed unavailable: {sync.error.message}</p>
      ) : proposals.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Dumbbell size={20} aria-hidden />
          <strong>No gym experiments yet</strong>
          <span>The gym A/B-tests prompt variants for the pipeline roles, scores them with a frozen judge, and promotes the winners. Proposals and champion promotions will appear here once a gym runs.</span>
        </div>
      ) : (
        <ul className="pc-learning__list">
          {proposals.map((p) => (
            <GymProposalRow key={p.id} p={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function GymProposalRow({ p }: { p: GymProposal }) {
  const statusColor = GYM_STATUS_COLOR[p.status] ?? '#94a3b8';
  const delta = deltaLabel(p.devAnchorDelta);
  return (
    <li className="pc-learning__row pc-learning__row--gym" title={p.rationale ?? undefined}>
      <span className="pc-learning__sev" style={{ background: statusColor }} aria-hidden />
      <span className="pc-learning__id">{p.role}</span>
      <span className="pc-learning__title">
        {p.rationale || <em className="pc-learning__muted">(no rationale)</em>}
      </span>
      <span className="pc-learning__meta">
        <span className="pc-learning__chip" style={{ color: statusColor, borderColor: statusColor }}>
          {p.status === 'accepted' ? <CheckCircle2 size={10} aria-hidden /> : p.status === 'rejected' ? <XCircle size={10} aria-hidden /> : <Clock size={10} aria-hidden />}
          {p.status}
        </span>
        <span className="pc-learning__chip pc-learning__chip--idea" title="The gym harness that ran this experiment">{p.harnessSlug}</span>
        <span
          className={`pc-learning__delta pc-learning__delta--${delta.tone}`}
          title="Judge-score change vs the current prompt — positive means the variant did better"
        >
          Δ {delta.text}
        </span>
        <span className="pc-learning__age" title={`Experiment cycle ${p.cycle}`}>c{p.cycle}</span>
        <span className="pc-learning__age">{whenLabel(p.decidedAt ?? p.createdAt)}</span>
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

const pctLabel = (v: number | null): string => (v == null ? '—' : `${Math.round(v * 100)}%`);
const compositeLabel = (v: number | null): string => (v == null ? '—' : v.toFixed(3));
function secsLabel(v: number | null): string {
  if (v == null) return '—';
  return v < 90 ? `${Math.round(v)}s` : `${(v / 60).toFixed(1)}m`;
}
function tokensLabel(v: number | null): string {
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}
const shortSha = (s: string): string => (s ? s.slice(0, 7) : '—');
function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ApiaryView() {
  const sync = useSyncQuery<{ instances: ApiaryInstance[] }>({ queryName: 'learning.apiary', args: {}, staleTime: 30_000 });
  const instances = sync.data?.[0]?.instances ?? [];
  const latest = instances[0];

  return (
    <section className="pc-learning__section">
      <div className="pc-learning__scoreboard" aria-label="Benchmark summary">
        <Stat label="composite" value={latest ? compositeLabel(latest.meanComposite) : '—'} tone="good" hint="Latest generation’s mean judge composite — higher is better. This is the headline benchmark; watch the trend, not the absolute number." />
        <Stat label="success" value={latest ? pctLabel(latest.successRate) : '—'} hint="Share of battery tasks the fleet solved without escalating." />
        <Stat label="time to green" value={latest ? secsLabel(latest.meanTimeToGreenSecs) : '—'} hint="Mean wall-clock to a solved task. Lower is better." />
        <Stat label="tokens / task" value={latest ? tokensLabel(latest.meanTokens) : '—'} hint="Mean tokens per solved task. Lower is cheaper." />
        <Stat label="escalations" value={latest ? pctLabel(latest.escalationRate) : '—'} tone="human" hint="Share of tasks that needed a human. Lower is better." />
      </div>

      <BenchmarkTrend instances={instances} />

      <HiveEvalTrendView />

      <BakeoffTrendView />

      <QueenWakeEfficiencyPanel />

      <EkgPanel />

      <RedQueenPanel />

      <ExperimentsPanel />

      <div className="pc-learning__sectionhead">
        <h2>Benchmark generations</h2>
        <button
          type="button"
          className="pc-learning__refresh"
          aria-label="Reload the benchmark"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {sync.loading && !sync.data ? (
        <p className="pc-learning__empty">Loading the benchmark…</p>
      ) : sync.error ? (
        <p className="pc-learning__empty">Benchmark unavailable: {sync.error.message}</p>
      ) : instances.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Gauge size={20} aria-hidden />
          <strong>No baseline runs yet</strong>
          <span>The IQ-battery is owner-gated — runs spend real budget, so they happen when the owner kicks one off, or via the monthly cadence routine once the owner sets its budget (it then benchmarks each new code generation automatically). It runs a fixed task corpus against the fleet and judges every run, so each generation is comparable; once generations land, the trend appears here — newest first, with the composite change vs the prior generation.</span>
        </div>
      ) : (
        <ul className="pc-learning__list">
          {instances.map((inst, i) => {
            const prev = instances[i + 1];
            const dComposite =
              inst.meanComposite != null && prev?.meanComposite != null ? inst.meanComposite - prev.meanComposite : null;
            const delta = deltaLabel(dComposite);
            return (
              <li key={inst.instanceId} className="pc-learning__row pc-learning__row--bench" title={inst.instanceId}>
                <span className="pc-learning__sev" style={{ background: '#34d399' }} aria-hidden />
                <span className="pc-learning__id" title={inst.codeSha}>{shortSha(inst.codeSha)}</span>
                <span className="pc-learning__benchcell">
                  <span className="pc-learning__benchnum" title="Mean judge composite for this generation">{compositeLabel(inst.meanComposite)}</span>
                  {i < instances.length - 1 && (
                    <span className={`pc-learning__delta pc-learning__delta--${delta.tone}`} title="Composite change vs the previous generation">
                      Δ {delta.text}
                    </span>
                  )}
                  <span className="pc-learning__benchmeta">{inst.successfulRuns}/{inst.totalRuns} solved</span>
                </span>
                <span className="pc-learning__meta">
                  <span className="pc-learning__age" title="Mean time to green">{secsLabel(inst.meanTimeToGreenSecs)}</span>
                  <span className="pc-learning__age" title="Mean tokens per task">{tokensLabel(inst.meanTokens)}</span>
                  <span className="pc-learning__age" title="Escalation rate (lower is better)">{pctLabel(inst.escalationRate)} esc</span>
                  <span className="pc-learning__age">{dateLabel(inst.createdAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
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

const ratioLabel = (v: number | null): string => (v == null ? '—' : `${v.toFixed(2)}×`);

function HiveEvalTrendView() {
  const sync = useSyncQuery<{ instances: HiveEvalGeneration[] }>({
    queryName: 'learning.hiveEvalTrend',
    args: {},
    staleTime: 30_000,
  });
  const instances = sync.data?.[0]?.instances ?? [];
  const latest = instances[0];
  // Reuse the BenchmarkTrend surface — the composite per generation, oldest→newest.
  const trendInstances: BenchmarkTrendInstance[] = instances.map((i) => ({
    instanceId: i.instanceId,
    codeSha: i.codeSha,
    createdAt: i.createdAt,
    totalRuns: i.totalRuns,
    successfulRuns: i.scoredRuns,
    meanComposite: i.meanComposite,
  }));

  return (
    <div className="pc-learning__hive-eval">
      <div className="pc-learning__sectionhead">
        <h2>Hive orchestration <em>good · efficient · fast?</em></h2>
        <button
          type="button"
          className="pc-learning__refresh"
          aria-label="Reload the Hive-orchestration trend"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {instances.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Gauge size={20} aria-hidden />
          <strong>No Hive-eval generations yet</strong>
          <span>
            This benchmark runs the WHOLE Hive (Queen + bees) on seeded scenarios and grades each run on
            outcome quality, efficiency, and speed — with an un-gameable gate (a fast-but-wrong run scores
            zero). Every run spends real budget, so it’s owner-gated: it runs when the owner sets the monthly
            cadence’s budget (P-051). Once generations land, the composite trend appears here — the yardstick
            for whether queen-execution / wave-dispatch / autonomy actually made the Hive better.
          </span>
        </div>
      ) : (
        <>
          <div className="pc-learning__scoreboard" aria-label="Hive orchestration summary">
            <Stat
              label="composite"
              value={latest ? compositeLabel(latest.meanComposite) : '—'}
              tone="good"
              hint="Latest generation’s mean Hive-run composite (0–10) — gated on outcome quality, then efficiency + speed. Higher is better; watch the trend, not the absolute number."
            />
            <Stat
              label="outcome gate"
              value={latest ? pctLabel(latest.outcomeGatePassRate) : '—'}
              hint="Share of runs that did a GOOD job (passed acceptance + caught the planted bug + no fabrication). Efficiency/speed earn ZERO below the gate."
            />
            <Stat
              label="critical-path"
              value={latest ? ratioLabel(latest.meanCriticalPathRatio) : '—'}
              hint="Measured wall-clock ÷ the computable ideal. ~1× = optimally parallel; higher = serialized/bottlenecked (a computed, un-gameable signal)."
            />
            <Stat
              label="fabrication"
              value={latest ? pctLabel(latest.fabricationRate) : '—'}
              tone="human"
              hint="Share of runs with a fabricated DONE (a claim ground truth contradicts). Lower is better — ideally zero."
            />
          </div>
          <BenchmarkTrend instances={trendInstances} />
        </>
      )}
    </div>
  );
}

// ─── Framework bake-off trend (plan-implementation-framework-2026-06-15 P-014) ──
//
// The A/B proof per bet: flip a flag OFF vs ON over the scored hive-eval corpus, diff the gated
// composite + outcome-gate pass rate. The SIBLING of the apiary + hive-orchestration trends — its
// own `learning.bakeoff` snapshot over hive_eval_bakeoff_deltas (migration 293). A regressed verdict
// auto-reverts the flag (P-015). Owner-gated (a real bake-off spends budget + needs the operator
// runtime) — graceful-empty until the first run lands.

const BAKEOFF_VERDICT_META: Record<BakeoffTrendRow['verdict'], { label: string; tone: 'good' | 'bad' | 'flat'; color: string }> = {
  improved: { label: 'improved', tone: 'good', color: '#34d399' },
  regressed: { label: 'regressed', tone: 'bad', color: '#f87171' },
  neutral: { label: 'neutral', tone: 'flat', color: '#94a3b8' },
  inconclusive: { label: 'inconclusive', tone: 'flat', color: '#64748b' },
};

function BakeoffTrendView() {
  const sync = useSyncQuery<{ rows: BakeoffTrendRow[] }>({
    queryName: 'learning.bakeoff',
    args: {},
    staleTime: 30_000,
  });
  const rows = sync.data?.[0]?.rows ?? [];
  // Each bet's CURRENT standing — rows arrive newest-first, so the first verdict per flag is latest
  // (the same logic as the canonical latestVerdictByFlag formatter; inlined to keep the client bundle
  // free of an operator-core value import).
  const standings: Array<{ flag: string; verdict: BakeoffTrendRow['verdict'] }> = [];
  const seenFlags = new Set<string>();
  for (const r of rows) {
    if (!seenFlags.has(r.flagKey)) {
      seenFlags.add(r.flagKey);
      standings.push({ flag: r.flagKey, verdict: r.verdict });
    }
  }

  return (
    <div className="pc-learning__hive-eval">
      <div className="pc-learning__sectionhead">
        <h2>Framework bake-off <em>does the bet help?</em></h2>
        <button
          type="button"
          className="pc-learning__refresh"
          aria-label="Reload the framework bake-off trend"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Gauge size={20} aria-hidden />
          <strong>No bake-offs yet</strong>
          <span>
            A bake-off runs the whole Hive twice over the seeded scenarios — once with a bet flag OFF,
            once ON — and diffs the gated composite + outcome-gate pass rate. It’s the un-gameable A/B
            proof that a change (compiled briefs, conflict-free placement, …) actually beats baseline; a
            drop in the gate auto-reverts the flag. Every run spends real budget and needs the operator
            runtime, so it’s owner-gated. Once a bake-off lands, each bet’s standing + the delta history
            appear here — newest first.
          </span>
        </div>
      ) : (
        <>
          <div className="pc-learning__scoreboard" aria-label="Bet standings">
            {standings.map(({ flag, verdict }) => (
              <Stat
                key={flag}
                label={flag.replace(/^papercusp-/, '')}
                value={BAKEOFF_VERDICT_META[verdict].label}
                tone={verdict === 'improved' ? 'good' : verdict === 'regressed' ? 'human' : 'auto'}
                hint={`Latest bake-off verdict for ${flag}: 'improved' = the flag-ON arm beat baseline; 'regressed' = it lost the outcome gate or dropped the composite (auto-reverted off); 'neutral' = no real change; 'inconclusive' = too few runs.`}
              />
            ))}
          </div>
          <ul className="pc-learning__list">
            {rows.map((r, i) => {
              const dc = deltaLabel(r.deltaMeanComposite);
              const meta = BAKEOFF_VERDICT_META[r.verdict];
              return (
                <li key={`${r.flagKey}-${r.at}-${i}`} className="pc-learning__row pc-learning__row--bench" title={r.flagKey}>
                  <span className="pc-learning__sev" style={{ background: meta.color }} aria-hidden />
                  <span className="pc-learning__id" title={r.flagKey}>{r.flagKey.replace(/^papercusp-/, '')}</span>
                  <span className="pc-learning__benchcell">
                    <span className={`pc-learning__delta pc-learning__delta--${meta.tone}`} title="The bake-off verdict for this run">{meta.label}</span>
                    <span className={`pc-learning__delta pc-learning__delta--${dc.tone}`} title="Change in mean gated composite (treatment − baseline)">Δcomp {dc.text}</span>
                    <span className="pc-learning__benchmeta" title="Change in outcome-gate pass rate (treatment − baseline)">Δgate {r.deltaGatePassRate >= 0 ? '+' : ''}{r.deltaGatePassRate.toFixed(2)}</span>
                  </span>
                  <span className="pc-learning__meta">
                    <span className="pc-learning__age">{whenLabel(r.at)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ─── Scout view (idea radar — routed ideas + tick health) ────────────────────

/** Rail → human label + accent for the routed-ideas rows. The canonical set is
    RoutedRail ('plan' | 'gym' | 'improvement' | 'instance') — open set, render
    whatever arrives. */
const RAIL_META: Record<string, { label: string; desc: string; color: string }> = {
  plan: { label: 'plan draft', desc: 'A draft plan awaiting Queen/owner triage — open it in the Create tab', color: '#7dd3fc' },
  gym: { label: 'gym', desc: 'Seeded into the gym quality-diversity experiment archive', color: '#34d399' },
  improvement: { label: 'improvement', desc: 'Filed as an improvement work-item (EI-…) in the backlog', color: '#a78bfa' },
  instance: { label: 'instance', desc: 'Registered as a genome-variant candidate for the apiary eval-battery', color: '#f472b6' },
};

/** The grade a row should display: an in-flight optimistic owner write wins,
    then the snapshot's stored grade, else null (ungraded). */
interface EffectiveGrade {
  grade: number;
  feedback: string | null;
  gradedBy: string;
}

const GRADE_MEANING: Record<number, string> = {
  1: 'a bad call — counts as a full loss for this lens',
  2: 'weak — mostly a loss',
  3: 'neutral — half win, half loss',
  4: 'useful — mostly a win',
  5: 'excellent — counts as a full win for this lens',
};

/** Attribution label per C-1's graded_by values ('owner' | 'Queen'). */
const graderLabel = (gradedBy: string): string => (gradedBy === 'owner' ? 'Owner' : gradedBy);

/** The tool-proxy response envelope varies (the parsed result | {result} | MCP
    content text) — unwrap whichever the dispatcher returns. */
function unwrapToolResult(d: unknown): Record<string, unknown> {
  const o = d as { content?: Array<{ type?: string; text?: string }>; result?: unknown } | null;
  const text = Array.isArray(o?.content) ? o.content.find((c) => c?.type === 'text')?.text : undefined;
  if (typeof text === 'string') {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const inner = o?.result ?? d;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
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
    <span className="pc-learning__stars" role="radiogroup" aria-label="Grade this idea 1 to 5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Tooltip key={n} label={`★${n} — ${GRADE_MEANING[n]}`}>
          <button
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`Grade ${n} of 5`}
            className={`pc-learning__star${value != null && n <= value ? ' is-on' : ''}`}
            disabled={busy}
            onClick={() => onRate(n)}
          >
            <Star size={size} aria-hidden fill={value != null && n <= value ? 'currentColor' : 'none'} />
          </button>
        </Tooltip>
      ))}
    </span>
  );
}

/** The note popover (open-state in nuqs `?grade=<ideaId>`): stars + a free-text
    critique saved together through `scout:grade-idea`. Mid-edit drafts are
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
  const [grade, setGrade] = useState<number | null>(current?.grade ?? null);
  const [draft, setDraft] = useState(current?.feedback ?? '');
  return (
    <div
      className="pc-learning__gradepanel"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="pc-learning__gradepanelrow">
        <StarControl value={grade} onRate={setGrade} size={16} />
        <span className="pc-learning__gradepanelhint">
          {grade == null ? 'Pick a grade — 5 counts as a win for this lens, 1 as a loss.' : `★${grade} — ${GRADE_MEANING[grade]}`}
        </span>
      </div>
      <textarea
        value={draft}
        rows={2}
        maxLength={2000}
        aria-label="Grading note"
        placeholder="Why? Scout quotes recent grading notes to the next cycle’s ideators."
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="pc-learning__gradepanelactions">
        <button type="button" className="pc-learning__panelbtn" onClick={onClose}>
          cancel
        </button>
        <button
          type="button"
          className="pc-learning__panelbtn pc-learning__panelbtn--primary"
          disabled={grade == null || busy}
          onClick={() => {
            if (grade != null) onSave(grade, draft.trim() ? draft.trim() : null);
          }}
        >
          {busy ? 'saving…' : 'save grade'}
        </button>
      </div>
    </div>
  );
}

/** ms → compact human duration: "45s", "2m 0s", "1h 3m". */
function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
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
function ThroughputView() {
  const sync = useSyncQuery<HiveThroughputSnapshot>({ queryName: 'learning.hiveThroughput', args: {}, staleTime: 30_000 });
  const hives = sync.data?.[0]?.hives ?? [];

  return (
    <section className="pc-learning__section">
      {hives.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <strong>No throughput recorded yet</strong>
          <span>
            The Queen hive loop records a tick every ~30s while a hive is <strong>started</strong> with queued work.
            Start a hive (or wait for its next wake) and its placement metrics appear here.
          </span>
        </div>
      ) : (
        hives.map((h) => {
          const m = h.latest;
          const rungs = m?.questionRungs ?? {};
          const rungTotal = Object.values(rungs).reduce<number>((a, b) => a + (Number(b) || 0), 0);
          const tickMs = m?.tickAt ? Date.parse(m.tickAt) : NaN;
          const utilPct = m ? Math.round(m.utilization * 100) : 0;
          const saturated = !!m && !h.operatingWell && m.utilization >= 1 && m.frontierDepth > 0;
          return (
            <div key={h.hiveSlug} className="pc-learning__throughputhive">
              <div className="pc-learning__flow" aria-label={`${h.hiveSlug} throughput health`}>
                <span
                  className={`pc-learning__flowchip ${h.operatingWell ? 'pc-learning__flowchip--wd-good' : 'pc-learning__flowchip--wd-warn'}`}
                  title="The hive whose Queen-loop throughput this is, how recently it ticked, and whether the loop is operating well (frontier draining, fleet not pegged, no stuck placements)."
                >
                  <Activity size={11} aria-hidden />
                  {h.hiveSlug}
                  <strong>{m && !Number.isNaN(tickMs) ? whenLabel(tickMs) : 'no ticks'}</strong>
                  <em>{h.operatingWell ? 'operating well' : 'needs attention'}</em>
                </span>
              </div>

              <div className="pc-learning__scoreboard" aria-label={`${h.hiveSlug} throughput`}>
                <Stat label="frontier" value={m ? m.frontierDepth : '—'} hint="Ready work waiting for placement (todo items) — the queue the Queen pours from." />
                <Stat
                  label="bees busy"
                  value={m ? `${m.beesBusy}/${m.beesCap}` : '—'}
                  tone={saturated ? 'human' : 'good'}
                  hint="Live placed bees vs the fleet ceiling. Pegged at cap with work still queued = starvation (raise the ceiling / widen the credential pool, D-006)."
                />
                <Stat label="utilization" value={m ? `${utilPct}%` : '—'} hint="Fleet utilization: bees busy ÷ cap." />
                <Stat label="placed / wake" value={m ? m.placements : '—'} tone="auto" hint="Bees newly placed since the previous tick — how fast the Queen fans work out." />
                <Stat label="completed" value={m ? m.completed : '—'} tone="auto" hint="Bees that finished in the tick window." />
                <Stat label="avg complete" value={formatDurationMs(m?.mttcMs)} hint="Mean-time-to-complete over bees that finished — how long a placement takes." />
                <Stat
                  label="stuck"
                  value={m ? m.stuckCount : '—'}
                  {...(m && m.stuckCount > 0 ? { tone: 'human' as const } : {})}
                  hint="Placed bees with a stale heartbeat — placements that stopped advancing and need a recovery wake (the placement watchdog, P-020)."
                />
                <Stat label="questions" value={rungTotal} hint="Bee questions resolved this window, split by rung below. Lights up when the question-ladder (B-10/B-17) lands; 0 until then." />
              </div>

              {rungTotal > 0 ? (
                <div className="pc-learning__flow" aria-label={`${h.hiveSlug} question rungs`}>
                  <span className="pc-learning__flowchip" title="Where bee questions resolved: bee-self / peer-vote / Queen / owner. The lower the rung, the less the owner was needed.">
                    <HelpCircle size={11} aria-hidden />
                    question rungs
                  </span>
                  {Object.entries(rungs).map(([rung, count]) => (
                    <span key={rung} className="pc-learning__lens" title={`${String(count)} question(s) resolved at the ${rung} rung`}>
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
        aria-label="Reload hive throughput"
        disabled={sync.fetching}
        onClick={() => sync.invalidate()}
      >
        <RefreshCw size={13} aria-hidden />
      </button>
    </section>
  );
}

function ScoutView() {
  const sync = useSyncQuery<ScoutSnapshot>({ queryName: 'learning.scout', args: {}, staleTime: 30_000 });
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
  const [gradeOpen, setGradeOpen] = useQueryState('grade', parseAsString);
  const [optimistic, setOptimistic] = useState<Record<string, EffectiveGrade>>({});
  const [savingId, setSavingId] = useState('');
  const [gradeError, setGradeError] = useState('');

  const effectiveGrade = (item: ScoutRoutedItem): EffectiveGrade | null => {
    const opt = optimistic[item.ideaId];
    if (opt) return opt;
    if (item.humanGrade == null) return null;
    return { grade: item.humanGrade, feedback: item.humanFeedback ?? null, gradedBy: item.gradedBy ?? 'owner' };
  };

  const submitGrade = async (item: ScoutRoutedItem, grade: number, feedback: string | null) => {
    setGradeError('');
    setSavingId(item.ideaId);
    const prevEntry = optimistic[item.ideaId] ?? null;
    // Optimistic: show the new grade immediately; the refetched snapshot
    // confirms it (or the catch below rolls it back).
    setOptimistic((m) => ({ ...m, [item.ideaId]: { grade, feedback, gradedBy: 'owner' } }));
    try {
      const res = await fetch('/api/agent-tools/scout/grade-idea', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ideaId: item.ideaId, grade, ...(feedback ? { feedback } : {}) }),
      });
      const raw: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = unwrapToolResult(raw);
      if (result.applied === false) throw new Error(String(result.reason ?? 'grade not applied'));
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
      setSavingId('');
    }
  };

  // Steering visibility (P-007): the persisted per-lens sampling weights,
  // shown as shares of the total so they read as "how Scout will lean".
  const lensEntries = useMemo<Array<[string, number]>>(() => {
    const w = snap?.lensWeights;
    if (!w) return [];
    const entries = Object.entries(w).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    const sum = entries.reduce((s, [, v]) => s + v, 0);
    if (entries.length === 0 || sum <= 0) return [];
    return entries
      .map(([k, v]) => [k, Math.round((v / sum) * 100)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  }, [snap]);

  // Deep-links: a routed idea opens its artifact's home surface (all nuqs, so
  // agents can drive the same navigation via ui:dispatch).
  const [, setTab] = useQueryState('tab', parseAsString);
  const [, setCreateView] = useQueryState('view', parseAsString);
  const [, setPlanSel] = useQueryState('plan', parseAsString);
  const [, setLviewRaw] = useQueryState('lview', parseAsString);
  const [, setLane] = useQueryState('lane', parseAsString);
  const [, setSrcSel] = useQueryState('lsrc', parseAsString);
  const [, setLsel] = useQueryState('lsel', parseAsString);
  const openRouted = (item: ScoutRoutedItem) => {
    if (item.rail === 'plan' && item.routedRef.startsWith('plan:')) {
      void setPlanSel(item.routedRef.slice('plan:'.length));
      void setCreateView('plans');
      void setTab('plans');
    } else if (item.rail === 'gym') {
      void setLviewRaw('gym');
    } else if (item.rail === 'instance') {
      void setLviewRaw('benchmark');
    } else {
      // improvement (wi:EI-…) and anything unknown → the improvements backlog,
      // selecting THAT row (?lsel) and resetting the lane/source filters so the
      // target is guaranteed visible (a sticky lane=auto would hide a
      // human-tier item and the click would look like a no-op).
      const id = item.routedRef.startsWith('wi:') ? item.routedRef.slice('wi:'.length) : item.routedRef;
      void setLsel(id);
      void setLane(null);
      void setSrcSel(null);
      void setLviewRaw('improvements');
    }
  };

  return (
    <section className="pc-learning__section">
      <div className="pc-learning__flow" aria-label="Scout tick health">
        <span
          className="pc-learning__flowchip"
          title={tick ? `The newest scout tick and its gate outcome.${tick.detail ? ` ${tick.detail}` : ''}` : 'Scout records a row per tick (gate outcomes, ideas generated/routed) once tick observability lands — no ticks recorded yet.'}
        >
          <Radar size={11} aria-hidden />
          last tick <strong>{tick && !Number.isNaN(tickMs) ? whenLabel(tickMs) : 'none yet'}</strong>
          {tick?.outcome ? <em>{tick.detail ? `${tick.outcome} · ${tick.detail}` : tick.outcome}</em> : null}
        </span>
      </div>

      <div className="pc-learning__scoreboard" aria-label="Scout summary">
        <Stat label="routed ideas" value={snap ? snap.totalRouted : '—'} hint="Ideas Scout has dispatched into a rail (plan draft, gym experiment, or work item) — its only output that counts." />
        {rails.map((r) => (
          <Stat key={r.rail} label={RAIL_META[r.rail]?.label ?? r.rail} value={r.count} tone="auto" hint={RAIL_META[r.rail]?.desc} />
        ))}
      </div>

      {lensEntries.length > 0 ? (
        <div className="pc-learning__flow" aria-label="Lens sampling weights">
          <span
            className="pc-learning__flowchip"
            title="Scout picks its creative lenses with these sampling weights — learned from routed-idea outcomes and grades (a ★5 counts as a win, a ★1 as a loss; a grade beats the system's own outcome guess)."
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
      ) : null}

      <div className="pc-learning__sectionhead">
        <h2>Routed ideas</h2>
        <button
          type="button"
          className="pc-learning__refresh"
          aria-label="Reload the scout feed"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {sync.loading && !snap ? (
        <p className="pc-learning__empty">Loading the scout ledger…</p>
      ) : sync.error ? (
        <p className="pc-learning__empty">Scout feed unavailable: {sync.error.message}</p>
      ) : recent.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Radar size={20} aria-hidden />
          <strong>Scout has not routed ideas yet</strong>
          <span>Scout sweeps the system on a cadence, but spends nothing unless its gates (idle, friction, budget, circuit-breaker) open — most ticks correctly do nothing. When an idea survives critique it’s routed into a plan draft, a gym experiment, an improvement work-item, or an instance candidate, and it appears here.</span>
        </div>
      ) : (
        <>
          {gradeError ? (
            <p className="pc-learning__empty" role="alert">
              Grade failed: {gradeError}
            </p>
          ) : null}
          <ul className="pc-learning__list">
            {recent.map((item) => {
              const meta = RAIL_META[item.rail] ?? { label: item.rail, desc: 'Routed idea', color: '#94a3b8' };
              const when = item.routedAt ? Date.parse(item.routedAt) : NaN;
              const eff = effectiveGrade(item);
              const isOpen = gradeOpen === item.ideaId;
              const saving = savingId === item.ideaId;
              return (
                <li key={item.ideaId} className={`pc-learning__row pc-learning__row--scout${isOpen ? ' is-grading' : ''}`}>
                  <span
                    className="pc-learning__rowmain"
                    role="button"
                    tabIndex={0}
                    onClick={() => openRouted(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openRouted(item);
                      }
                    }}
                    title={`${meta.desc}\n${item.routedRef}`}
                  >
                    <span className="pc-learning__sev" style={{ background: meta.color }} aria-hidden />
                    <span className="pc-learning__id" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="pc-learning__title">{item.title ?? item.routedRef}</span>
                  </span>
                  <span className="pc-learning__meta">
                    <span className="pc-learning__chip pc-learning__chip--idea" title="Creative lens that produced this idea">{item.lens}</span>
                    {item.outcome && item.outcome !== 'pending' ? (
                      <span className="pc-learning__score" title="Outcome from the change feed">{item.outcome}</span>
                    ) : null}
                    <span className="pc-learning__age">{!Number.isNaN(when) ? whenLabel(when) : ''}</span>
                    {/* Grade controls (P-006). A bare star click writes immediately
                        (preserving any existing note); the note button opens the
                        popover. stopPropagation so grading never opens the artifact. */}
                    <span
                      className="pc-learning__grade"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <StarControl
                        value={eff?.grade ?? null}
                        busy={saving}
                        onRate={(n) => void submitGrade(item, n, eff?.feedback ?? null)}
                      />
                      {eff ? (
                        <span
                          className="pc-learning__gradechip"
                          title={
                            eff.feedback
                              ? `Graded by ${graderLabel(eff.gradedBy)}: “${eff.feedback}”`
                              : `Graded by ${graderLabel(eff.gradedBy)} — click the stars to regrade (your grade always wins)`
                          }
                        >
                          ★{eff.grade} · {graderLabel(eff.gradedBy)}
                        </span>
                      ) : null}
                      <Tooltip label={eff?.feedback ? `Edit the grading note: “${eff.feedback}”` : 'Grade with a note — ideators read recent notes next cycle'}>
                        <button
                          type="button"
                          className="pc-learning__notebtn"
                          aria-label={eff?.feedback ? 'Edit the grading note' : 'Grade with a note'}
                          onClick={() => void setGradeOpen(isOpen ? null : item.ideaId)}
                        >
                          {eff?.feedback ? <MessageSquareText size={12} aria-hidden /> : <MessageSquarePlus size={12} aria-hidden />}
                        </button>
                      </Tooltip>
                    </span>
                  </span>
                  {isOpen ? (
                    <GradePanel
                      current={eff}
                      busy={saving}
                      onSave={(grade, feedback) => {
                        void submitGrade(item, grade, feedback).then(() => void setGradeOpen(null));
                      }}
                      onClose={() => void setGradeOpen(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// ─── Knowledge view (agent-insight runbooks + memory health, P-008) ──────────

function dateShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function KnowledgeView() {
  const sync = useSyncQuery<{ insights: InsightsSnapshot; memory: MemoryHealth | null }>({ queryName: 'learning.knowledge', args: {}, staleTime: 30_000 });
  const snap = sync.data?.[0];
  const insights = snap?.insights;
  const memory = snap?.memory ?? null;
  const [, setTab] = useQueryState('tab', parseAsString);

  return (
    <section className="pc-learning__section">
      <div className="pc-learning__scoreboard" aria-label="Knowledge summary">
        <Stat label="runbooks" value={insights ? insights.count : '—'} tone="good" hint="Active agent-insight runbooks in the library (retired/superseded excluded)." />
        <Stat label="memories" value={memory ? memory.totalMemories : '—'} hint="Canonical memories in the shared store — the facts agents recall before grepping." />
        <Stat label="feedback 30d" value={memory ? memory.feedback30d : '—'} tone="human" hint="Memory feedback events (edits, forgets, corrections) in the last 30 days — the loop’s pulse. Zero against a populated store means the feedback loop isn’t wired on yet." />
      </div>

      <div className="pc-learning__sectionhead">
        <h2>Recent runbooks</h2>
        <button
          type="button"
          className="pc-learning__refresh"
          aria-label="Reload the knowledge feed"
          disabled={sync.fetching}
          onClick={() => sync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {sync.loading && !snap ? (
        <p className="pc-learning__empty">Loading the runbook library…</p>
      ) : sync.error ? (
        <p className="pc-learning__empty">Knowledge feed unavailable: {sync.error.message}</p>
      ) : !insights || insights.recent.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <BookOpen size={20} aria-hidden />
          <strong>No runbooks yet</strong>
          <span>When an agent works through a confusing failure or a subtle invariant, it writes a short PR-reviewed runbook so the next agent doesn’t lose the same hour. They’ll appear here as they land.</span>
        </div>
      ) : (
        <ul className="pc-learning__list">
          {insights.recent.map((ins) => (
            <li key={ins.slug} className="pc-learning__row" title={ins.description || ins.title}>
              <span className="pc-learning__sev" style={{ background: '#7dd3fc' }} aria-hidden />
              <span className="pc-learning__id">{ins.slug}</span>
              <span className="pc-learning__title">{ins.title}</span>
              <span className="pc-learning__meta">
                {ins.tags[0] ? <span className="pc-learning__chip pc-learning__chip--idea">{ins.tags[0]}</span> : null}
                <span className="pc-learning__age" title="Last touched">{dateShort(ins.modifiedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <MemoryHealthCard memory={memory} />

      <DemandPanel />

      <div className="pc-learning__empty pc-learning__empty--card pc-learning__knowledge">
        <BookOpen size={22} aria-hidden />
        <strong>Agent insights — the fleet’s runbooks</strong>
        <span>
          When the fleet hits something non-obvious — a confusing failure, a subtle invariant, a library quirk — it writes a short,
          PR-reviewed runbook so the next agent doesn’t lose the same hour. That library is the system’s durable, hard-won knowledge.
        </span>
        <button type="button" className="pc-learning__cta" onClick={() => void setTab('insights')}>
          <ArrowUpRight size={13} aria-hidden /> Open the Insights library
        </button>
      </div>
    </section>
  );
}

// ─── Learnings view (a hive's editable shared memory — learning-packs P-008) ──

type HiveLearningRowT = HiveLearningsSnapshot['rows'][number];

function LearningsView({ hive }: { hive: string }) {
  // P-042: the hive selection now lives at the TAB level (`?lhive=`, the shared
  // lens) — passed in as `hive`/`hives` instead of owned here, so the same
  // selection drives Improvements + Gym too. The origin filter (`?lpack=`) stays
  // local to this view.
  const [lpack, setLpack] = useQueryState('lpack', parseAsString.withDefault('all'));

  const sync = useSyncQuery<HiveLearningsSnapshot>({
    queryName: 'learning.hive',
    args: { hive },
    enabled: hive.length > 0,
    staleTime: 30_000,
  });
  const snap = sync.data?.[0];
  const rows = snap?.rows ?? [];
  const filtered =
    lpack === 'all' ? rows : lpack === 'organic' ? rows.filter((r) => !r.packId) : rows.filter((r) => r.packId === lpack);

  // ── Pack management (P-009/P-010/P-013): install / mute / uninstall /
  //    upgrade, with the conflict-review cards when the backend says
  //    review_required. Transient action state → useState (nuqs exception).
  const catalog = useSyncQuery<{ id: string; title: string; version: string; itemCount: number }>({
    queryName: 'learningPacks.list',
    args: {},
    staleTime: 60_000,
  });
  const installedIds = new Set((snap?.packs ?? []).map((p) => p.packId));
  const installable = (catalog.data ?? []).filter((p) => !installedIds.has(p.id));
  const [addPack, setAddPack] = useState('');
  const [busyPack, setBusyPack] = useState('');
  const [packError, setPackError] = useState('');
  const [reviewState, setReviewState] = useState<{
    mode: 'install' | 'upgrade';
    pack: string;
    review: InstallReview;
    choices: Record<string, InstallAction>;
  } | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const { prompt: askPrompt, element: promptEl } = usePromptDialog();

  const packPost = async (
    path: 'install' | 'upgrade' | 'uninstall' | 'set-enabled',
    body: Record<string, unknown>,
    mode?: 'install' | 'upgrade',
  ) => {
    setPackError('');
    setBusyPack(String(body.pack ?? ''));
    try {
      const res = await fetch(`/api/learning-packs/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hive, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        review?: InstallReview;
        error?: string;
      };
      if (data.reason === 'review_required' && data.review && mode) {
        // Preselect the backend's defaults (clashes skip — D-003).
        const choices: Record<string, InstallAction> = {};
        for (const item of data.review.items) choices[item.itemId] = item.defaultAction;
        setReviewState({ mode, pack: String(body.pack), review: data.review, choices });
        return;
      }
      if (!res.ok || data.ok === false) setPackError(data.error ?? data.reason ?? `HTTP ${res.status}`);
      setReviewState(null);
    } catch (e) {
      setPackError((e as Error).message ?? 'network error');
    } finally {
      setBusyPack('');
      sync.invalidate();
      catalog.invalidate();
    }
  };

  const applyReview = () => {
    if (!reviewState) return;
    const resolutions = Object.entries(reviewState.choices).map(([itemId, action]) => ({ itemId, action }));
    void packPost(reviewState.mode, { pack: reviewState.pack, resolutions });
  };

  const forget = async (row: HiveLearningRowT) => {
    const ok = await askConfirm({
      title: 'Remove this learning?',
      body: row.text.slice(0, 160),
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetch(`/api/user/memory?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
    } finally {
      sync.invalidate();
    }
  };
  const edit = async (row: HiveLearningRowT) => {
    const next = await askPrompt({
      title: 'Edit learning',
      label: 'Learning text',
      body: 'Agents recall the exact text.',
      defaultValue: row.text,
      submitLabel: 'Save',
      validate: (value) => (value.trim() ? null : 'Learning text is required.'),
    });
    if (next == null || !next.trim() || next === row.text) return;
    try {
      await fetch('/api/user/memory', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, text: next.trim() }),
      });
    } finally {
      sync.invalidate();
    }
  };

  const actionBtn: React.CSSProperties = {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--fg-dim)',
    cursor: 'pointer',
    fontSize: 11,
    padding: '1px 7px',
  };

  return (
    <>
    {confirmEl}
    {promptEl}
    <section className="pc-learning__section">
      {/* The hive picker now lives in the tab header (P-042) — this strip keeps
          only the origin filter, scoped to the header-selected hive. */}
      <div className="pc-learning__flow" aria-label="Learnings scope">
        <label className="pc-learning__flowchip" style={{ gap: 6 }}>
          show
          <Select
            ariaLabel="Filter by origin"
            value={lpack}
            onChange={(v: string) => void setLpack(v)}
            options={[
              { value: 'all', label: 'everything' },
              { value: 'organic', label: 'hive-learned only' },
              ...(snap?.packs ?? []).map((p) => ({ value: p.packId, label: `pack: ${p.packId}` })),
            ]}
          />
        </label>
      </div>

      <div className="pc-learning__scoreboard" aria-label="Learnings summary">
        <Stat label="learnings" value={snap ? rows.length : '—'} hint="Everything in this hive's shared memory pool — every agent in the hive recalls these." />
        {(snap?.packs ?? []).map((p) => (
          <Stat
            key={p.packId}
            label={`${p.packId}${p.packVersion ? ` v${p.packVersion}` : ''}`}
            value={`${p.present}${p.packTotal ? `/${p.packTotal}` : ''}`}
            tone="auto"
            hint={`Seeded from the ${p.packId} learning pack — ${p.present} present (${p.modified} edited), ${p.notPresent} not seeded or removed.`}
          />
        ))}
        <Stat label="hive-learned" value={snap ? snap.organicCount : '—'} tone="good" hint="Conventions and gotchas this hive's agents (or you) recorded — not from a pack." />
      </div>

      {/* Pack management (P-009/P-013): mute / uninstall / adopt-new + add-pack. */}
      {hive !== '' && (
        <div className="pc-learning__flow" aria-label="Pack management" style={{ flexWrap: 'wrap' }}>
          {(snap?.packs ?? []).map((p) => (
            <span key={p.packId} className="pc-learning__flowchip" style={{ gap: 6 }}>
              <strong>{p.packId}</strong>
              {p.enabled === false ? (
                <Tooltip label="Muted — rows stay stored but are not injected into agent turns">
                  <em>muted</em>
                </Tooltip>
              ) : null}
              <Tooltip label={p.enabled === false ? 'Resume injecting this pack' : 'Stop injecting this pack (rows stay stored)'}>
                <button
                  type="button"
                  style={actionBtn}
                  disabled={busyPack === p.packId}
                  onClick={() => void packPost('set-enabled', { pack: p.packId, enabled: p.enabled === false })}
                >
                  {p.enabled === false ? 'unmute' : 'mute'}
                </button>
              </Tooltip>
              <Tooltip label="Remove this pack's rows (your edited rows are kept)">
                <button
                  type="button"
                  style={actionBtn}
                  disabled={busyPack === p.packId}
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: `Uninstall ${p.packId}?`,
                      body: 'Rows you edited are kept.',
                      confirmLabel: 'Uninstall',
                      destructive: true,
                    });
                    if (ok) {
                    void packPost('uninstall', { pack: p.packId });
                  }
                  }}
                >
                  uninstall
                </button>
              </Tooltip>
              {p.updateAvailable ? (
                <Tooltip label={`Adopt the new learnings in v${p.availableVersion} — rows you already have are never auto-changed`}>
                  <button
                    type="button"
                    style={{ ...actionBtn, borderColor: 'var(--accent)', color: 'var(--accent)' }}
                    disabled={busyPack === p.packId}
                    onClick={() => void packPost('upgrade', { pack: p.packId }, 'upgrade')}
                  >
                    v{p.availableVersion} available
                  </button>
                </Tooltip>
              ) : null}
            </span>
          ))}
          {installable.length > 0 && (
            <span className="pc-learning__flowchip" style={{ gap: 6 }}>
              <Select
                ariaLabel="Add a learning pack"
                value={addPack}
                onChange={(v: string) => setAddPack(v)}
                placeholder="add a pack…"
                options={installable.map((p) => ({
                  value: p.id,
                  label: `${p.title} — ${p.itemCount} learnings`,
                }))}
              />
              <button
                type="button"
                style={actionBtn}
                disabled={!addPack || busyPack !== ''}
                onClick={() => void packPost('install', { pack: addPack }, 'install')}
              >
                install
              </button>
            </span>
          )}
        </div>
      )}
      {packError ? <p className="pc-learning__empty" role="alert">Pack action failed: {packError}</p> : null}

      {/* P-032 (B-11): fleet→pack candidates awaiting the owner's adopt/dismiss. */}
      <LearningPackCandidates />

      {/* P-011 prune nudge: a bloated pool crowds the per-turn injection budget. */}
      {rows.length > 80 && (
        <p className="pc-learning__empty" style={{ color: 'var(--warn, #f59e0b)' }}>
          This hive carries {rows.length} learnings across {(snap?.packs ?? []).length} pack
          {(snap?.packs ?? []).length === 1 ? '' : 's'} — more than fits one turn&rsquo;s memory budget, so the least
          turn-relevant are withheld. Consider pruning duplicates or muting a pack.
        </p>
      )}

      {/* The conflict-review cards (P-010, D-003): incoming vs existing,
          per-item action, defaults preselected — never a silent union. */}
      {reviewState && (
        <div style={{ border: '1px solid var(--accent)', borderRadius: 8, padding: '12px 14px', margin: '10px 0' }} data-testid="pack-review">
          <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>
            Review: {reviewState.mode === 'upgrade' ? 'adopt new learnings from' : 'install'} {reviewState.pack} —{' '}
            {reviewState.review.conflicts} conflict{reviewState.review.conflicts === 1 ? '' : 's'}, {reviewState.review.duplicates} duplicate
            {reviewState.review.duplicates === 1 ? '' : 's'}, {reviewState.review.clean} clean
          </p>
          <p style={{ margin: '0 0 10px', fontSize: 11.5, color: 'var(--fg-mute)' }}>
            Clean items install as-is. For each clash, pick what wins — your existing learnings outrank the incoming pack by default.
          </p>
          {reviewState.review.items.filter((i) => i.status !== 'clean').map((item) => (
            <div key={item.itemId} style={{ borderTop: '1px solid var(--border)', padding: '8px 0', fontSize: 12 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-mute)', marginBottom: 2 }}>incoming ({item.status})</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{item.incoming}</div>
                </div>
                {item.existing && (
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--fg-mute)', marginBottom: 2 }}>
                      existing ({item.existing.organic ? 'hive-learned' : `pack: ${item.existing.packId ?? '?'}`})
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{item.existing.text}</div>
                  </div>
                )}
              </div>
              {item.summary ? <div style={{ marginTop: 4, color: 'var(--warn, #f59e0b)', fontSize: 11.5 }}>⚠ {item.summary}</div> : null}
              <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11.5 }}>
                <Select
                  ariaLabel={`Resolution for ${item.itemId}`}
                  value={reviewState.choices[item.itemId] ?? item.defaultAction}
                  onChange={(a) => setReviewState((s) => (s ? { ...s, choices: { ...s.choices, [item.itemId]: a as InstallAction } } : s))}
                  options={[
                    { value: 'skip', label: 'keep existing' },
                    { value: 'replace', label: 'take incoming' },
                    { value: 'keep-both', label: 'keep both' },
                  ]}
                />
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" style={actionBtn} onClick={() => setReviewState(null)}>cancel</button>
            <button
              type="button"
              style={{ ...actionBtn, borderColor: 'var(--accent)', color: 'var(--accent)' }}
              disabled={busyPack !== ''}
              onClick={applyReview}
            >
              apply
            </button>
          </div>
        </div>
      )}

      <div className="pc-learning__sectionhead">
        <h2>Shared memory</h2>
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

      {hive === '' ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Brain size={20} aria-hidden />
          <strong>No hives yet</strong>
          <span>Create a hive and it starts with a default learning pack — curated working wisdom its agents inherit from the first wake. It appears here, fully editable.</span>
        </div>
      ) : sync.loading && !snap ? (
        <p className="pc-learning__empty">Loading the hive&rsquo;s shared memory…</p>
      ) : snap?.unavailable ? (
        <p className="pc-learning__empty">Memory store unavailable — try reloading.</p>
      ) : filtered.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Brain size={20} aria-hidden />
          <strong>Nothing here yet</strong>
          <span>This hive&rsquo;s shared memory is empty for this filter. Seeded pack learnings and agent-recorded conventions both land here.</span>
        </div>
      ) : (
        <ul className="pc-learning__list">
          {filtered.map((r) => (
            <li key={r.id} className="pc-learning__row" style={{ alignItems: 'flex-start' }}>
              <span
                className="pc-learning__sev"
                style={{ background: r.packId ? 'var(--accent)' : 'var(--ok)', marginTop: 5 }}
                aria-hidden
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.text}</span>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3, fontSize: 10.5, color: 'var(--fg-mute)' }}>
                  {r.packId ? (
                    <span title={`Seeded from the ${r.packId} learning pack${r.packState === 'modified' ? ' — edited since seeding' : ''}`}>
                      <span style={{ border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>
                        pack: {r.packId}{r.packVersion ? ` v${r.packVersion}` : ''}
                      </span>
                      {r.packState === 'modified' ? ' · edited' : ''}
                    </span>
                  ) : (
                    <span title={`Recorded by ${r.createdBy ?? 'an agent'} — this hive's own learning`}>hive-learned{r.createdBy ? ` · ${r.createdBy}` : ''}</span>
                  )}
                  {r.kind ? <span>{r.kind}</span> : null}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                <Tooltip label="Edit the learning text">
                  <button type="button" style={actionBtn} onClick={() => void edit(r)}>edit</button>
                </Tooltip>
                <Tooltip label="Remove this learning from the hive's memory">
                  <button type="button" style={actionBtn} onClick={() => void forget(r)}>remove</button>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
    </>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────────

function Stat({ label, value, tone, hint }: { label: string; value: number | string; tone?: 'auto' | 'human' | 'good'; hint?: string }) {
  return (
    <div className={`pc-learning__stat${tone ? ` pc-learning__stat--${tone}` : ''}`} title={hint}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function LearningStyles() {
  return (
    <style>{`
      .pc-learning { display: flex; flex-direction: column; min-height: 0; padding: 14px 16px 20px; gap: 12px; overflow-y: auto; }
      .pc-learning__header { display: flex; align-items: flex-start; gap: 12px; }
      .pc-learning__copy { flex: 1; min-width: 0; }
      .pc-learning__copy h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 20px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
      .pc-learning__copy p { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-mute, #7f9bb4); max-width: 78ch; }

      .pc-learning__controls { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .pc-learning__subnav { display: inline-flex; gap: 6px; }
      .pc-learning__subtab {
        display: inline-flex; align-items: center; gap: 7px;
        padding: 7px 13px; border-radius: 10px; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__subtab span { display: flex; flex-direction: column; line-height: 1.15; font-size: 12.5px; font-weight: 650; text-align: left; }
      .pc-learning__subtab em { font-style: normal; font-size: 10px; font-weight: 500; color: var(--fg-mute, #7f9bb4); text-transform: uppercase; letter-spacing: 0; }
      .pc-learning__subtab.is-active { color: var(--fg, #e7f7ff); border-color: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.12); }
      .pc-learning__subtab.is-active em { color: color-mix(in oklab, #34d399, white 12%); }

      .pc-learning__howtoggle {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 12px; font-size: 11.5px; font-weight: 600; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: transparent; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__howtoggle.is-on { color: var(--fg-dim, #b9d4e8); border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.07); }

      /* Tab-level per-Hive lens picker (P-042) — sits with the How toggle. */
      .pc-learning__controlsright { display: inline-flex; align-items: center; gap: 8px; }
      .pc-learning__hivepick {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 10px; font-size: 11.5px; font-weight: 600; border-radius: 999px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__hivepicklabel { text-transform: uppercase; font-size: 10px; letter-spacing: 0; }

      .pc-learning__how {
        list-style: none; margin: 0; padding: 11px 13px;
        display: flex; flex-wrap: wrap; gap: 16px;
        border: 1px dashed var(--border, rgba(125, 211, 252, 0.2)); border-radius: 12px;
        background: var(--bg-2, rgba(255, 255, 255, 0.02));
      }
      .pc-learning__howstep { display: flex; gap: 9px; flex: 1 1 230px; min-width: 210px; }
      .pc-learning__hownum {
        display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px;
        border-radius: 50%; font-size: 10.5px; font-weight: 700;
        color: #34d399; border: 1px solid rgba(52, 211, 153, 0.45);
      }
      .pc-learning__howbody { display: flex; flex-direction: column; gap: 2px; }
      .pc-learning__howbody strong { font-size: 12px; font-weight: 700; color: var(--fg-dim, #b9d4e8); }
      .pc-learning__howbody em { font-style: normal; font-size: 11.5px; line-height: 1.45; color: var(--fg-mute, #7f9bb4); }

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
      .pc-learning__stat--good strong { color: #7dd3fc; }

      .pc-learning__section { display: flex; flex-direction: column; gap: 10px; }
      .pc-learning__sectionhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
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
        padding: 8px 11px; border-radius: 8px;
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
      .pc-learning__row--scout.is-grading { border-color: rgba(251, 191, 36, 0.45); }
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
      .pc-learning__gradepanelhint { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__gradepanel textarea { background: var(--bg-2, rgba(255, 255, 255, 0.03)); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); border-radius: 7px; color: var(--fg, #e7f7ff); font-size: 12px; font-family: inherit; line-height: 1.45; padding: 6px 9px; resize: vertical; }
      .pc-learning__gradepanelactions { display: flex; justify-content: flex-end; gap: 8px; }
      .pc-learning__panelbtn { padding: 4px 11px; font-size: 11.5px; font-weight: 650; border-radius: 7px; cursor: pointer; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); background: transparent; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__panelbtn--primary { border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); color: #fcd34d; }
      .pc-learning__panelbtn:disabled { opacity: 0.5; cursor: default; }

      /* Lens sampling weights (P-007 steering visibility). */
      .pc-learning__lens { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); background: var(--bg-2, rgba(255, 255, 255, 0.03)); color: var(--fg-mute, #7f9bb4); }
      .pc-learning__lens em { font-style: normal; color: var(--fg-dim, #b9d4e8); }
      .pc-learning__lens strong { font-weight: 740; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
      .pc-learning__lensbar { width: 44px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
      .pc-learning__lensbar span { display: block; height: 100%; border-radius: 2px; background: #a78bfa; }

      .pc-learning__empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 28px 16px; color: var(--fg-mute, #7f9bb4); font-size: 12.5px; }
      .pc-learning__empty--card { border: 1px dashed var(--border, rgba(125, 211, 252, 0.2)); border-radius: 12px; }
      .pc-learning__empty strong { color: var(--fg-dim, #b9d4e8); font-size: 13px; }
      .pc-learning__empty span { max-width: 58ch; }

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
    `}</style>
  );
}
