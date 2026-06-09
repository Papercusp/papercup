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
 *     (graceful empty until Scout routes its first idea / P-034 ticks land).
 *   - **Knowledge**: agent-insight runbook count + recent-5 and a memory-health
 *     strip via `learning.knowledge`, cross-linking to the full Insights tab
 *     (`?tab=insights`) — a teaser, never a duplicate of that tab.
 *
 * Each sub-view carries a plain-language "how this works" step strip (nuqs `?how=`,
 * shown by default) so the tab explains itself; every stat and chip carries a hover
 * hint.
 *
 * All user-meaningful state is in the URL via nuqs (CLAUDE.md). Styled with the
 * shared app tokens (--fg/--accent/…), matching AdvShell + AdvConversationsTab.
 */
import { useMemo } from 'react';
import { useQueryState, parseAsStringEnum, parseAsBoolean, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { GraduationCap, RefreshCw, ShieldCheck, UserRound, CheckCircle2, Dumbbell, Sparkles, XCircle, Clock, HelpCircle, Gauge, BookOpen, ArrowUpRight, ArrowUp, ArrowDown, Minus, Activity, Repeat2, Hourglass, Radar, Brain } from 'lucide-react';
import type { ImprovementDigest, ScoredItem } from '@papercusp/operator-core/lib/harness/improvements/digest';
import type { ImprovementFlow } from '@papercusp/operator-core/lib/harness/improvements/flow-metrics';
import type { InsightsSnapshot, MemoryHealth } from '@papercusp/operator-core/lib/memory/knowledge-read';
import type { ScoutSnapshot } from '@papercusp/operator-core/lib/sync-resolver/learning-scout-read';

const LVIEWS = ['improvements', 'gym', 'benchmark', 'scout', 'knowledge'] as const;
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
};

export default function LearningTab() {
  const [lview, setLview] = useQueryState('lview', parseAsStringEnum<LView>([...LVIEWS]).withDefault('improvements'));
  const [showHow, setShowHow] = useQueryState('how', parseAsBoolean.withDefault(true));
  const view: LView = (LVIEWS as readonly string[]).includes(lview) ? (lview as LView) : 'improvements';
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
            aria-selected={lview === 'knowledge'}
            className={`pc-learning__subtab${lview === 'knowledge' ? ' is-active' : ''}`}
            onClick={() => void setLview('knowledge')}
          >
            <BookOpen size={13} aria-hidden />
            <span>Knowledge<em>agent insights</em></span>
          </button>
        </div>
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
        <GymView />
      ) : view === 'benchmark' ? (
        <ApiaryView />
      ) : view === 'scout' ? (
        <ScoutView />
      ) : view === 'knowledge' ? (
        <KnowledgeView />
      ) : (
        <ImprovementsView />
      )}

      <p className="pc-learning__footnote">
        Improvements fix problems, the gym tunes the agents, the benchmark checks whether it’s all working, and Scout hunts for ideas — captured knowledge lives in Knowledge / Insights.
      </p>

      <LearningStyles />
    </div>
  );
}

// ─── Improvements view ───────────────────────────────────────────────────────

const LANES = ['all', 'auto', 'human'] as const;
type Lane = (typeof LANES)[number];

/** Severity → accent. Matches the feed/coord severity palette. */
const SEV_COLOR: Record<string, string> = {
  critical: '#f87171',
  major: '#fb923c',
  minor: '#fbbf24',
  nit: '#94a3b8',
};

function ageLabel(days: number): string {
  if (days < 1 / 24) return 'just now';
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

function ImprovementsView() {
  const sync = useSyncQuery<ImprovementDigest & { flow?: ImprovementFlow }>({ queryName: 'learning.improvements', args: {}, staleTime: 30_000 });
  const digest = sync.data?.[0];
  const [lane, setLane] = useQueryState('lane', parseAsStringEnum<Lane>([...LANES]).withDefault('all'));

  const rows = useMemo<ScoredItem[]>(() => {
    if (!digest) return [];
    if (lane === 'auto') return digest.autoEligible;
    if (lane === 'human') return digest.humanQueue;
    return [...digest.autoEligible, ...digest.humanQueue];
  }, [digest, lane]);

  const resolved = digest?.byState?.resolved ?? 0;

  return (
    <section className="pc-learning__section">
      {digest?.flow ? <FlowStrip flow={digest.flow} /> : null}

      <div className="pc-learning__scoreboard" aria-label="Improvements summary">
        <Stat label="captured" value={digest?.total ?? '—'} hint="Everything ever filed — problems, friction, and ideas, open or not." />
        <Stat label="open" value={digest?.open ?? '—'} hint="Not fixed yet." />
        <Stat label="auto-fixable" value={digest?.autoEligible.length ?? '—'} tone="auto" hint="Open bugs that touch no protected surface — agents may fix these without asking you." />
        <Stat label="needs review" value={digest?.humanQueue.length ?? '—'} tone="human" hint="Open items that need your judgment — risky surfaces, behaviour changes, or new features." />
        <Stat label="resolved" value={resolved} tone="good" hint="Fixed and closed." />
      </div>

      <div className="pc-learning__sectionhead">
        <h2>Captured improvements</h2>
        <div className="pc-learning__inlinetools">
          <div className="pc-learning__lanes" role="tablist" aria-label="Triage lane">
            {LANES.map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={lane === l}
                className={`pc-learning__lane${lane === l ? ' is-active' : ''}`}
                title={l === 'auto' ? 'Bugs agents may fix on their own' : l === 'human' ? 'Items waiting on your judgment' : undefined}
                onClick={() => void setLane(l)}
              >
                {l === 'all' ? 'All' : l === 'auto' ? 'Auto-fixable' : 'Needs review'}
              </button>
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
            <ImprovementRow key={it.id} item={it} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ImprovementRow({ item }: { item: ScoredItem }) {
  const sevColor = SEV_COLOR[item.severity ?? 'minor'] ?? '#94a3b8';
  const human = item.tier === 'human';
  return (
    <li className="pc-learning__row" title={item.tierReason}>
      <span className="pc-learning__sev" style={{ background: sevColor }} aria-hidden />
      <span className="pc-learning__id">{item.id}</span>
      <span className="pc-learning__title">{item.title}</span>
      <span className="pc-learning__meta">
        <span className="pc-learning__chip" style={{ color: sevColor, borderColor: sevColor }}>
          {item.severity ?? '—'}
        </span>
        {item.ideaType ? <span className="pc-learning__chip pc-learning__chip--idea">{item.ideaType}</span> : null}
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
    </div>
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
  accepted: '#34d399',
  pending: '#fbbf24',
  rejected: '#f87171',
  superseded: '#94a3b8',
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

function GymView() {
  const sync = useSyncQuery<GymSnapshot>({ queryName: 'learning.gym', args: {}, staleTime: 30_000 });
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
          <span>The IQ-battery baseline is owner-gated — the gen-0 run spends real budget, so it only happens when the owner kicks it off. It runs a fixed task corpus against the fleet and judges every run, so each generation is comparable; once the baseline lands, the trend appears here — newest first, with the composite change vs the prior generation.</span>
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

// ─── Scout view (idea radar — routed ideas + tick health) ────────────────────

/** Rail → human label + accent for the routed-ideas rows. */
const RAIL_META: Record<string, { label: string; desc: string; color: string }> = {
  plan: { label: 'plan', desc: 'Routed into plan drafts for review', color: '#7dd3fc' },
  gym: { label: 'gym', desc: 'Routed into gym experiments', color: '#34d399' },
  wi: { label: 'work item', desc: 'Routed into work items', color: '#a78bfa' },
};

function ScoutView() {
  const sync = useSyncQuery<ScoutSnapshot>({ queryName: 'learning.scout', args: {}, staleTime: 30_000 });
  const snap = sync.data?.[0];
  const rails = snap?.railCounts ?? [];
  const tick = snap?.lastTick ?? null;
  const tickMs = tick?.at ? Date.parse(tick.at) : NaN;

  return (
    <section className="pc-learning__section">
      <div className="pc-learning__flow" aria-label="Scout tick health">
        <span
          className="pc-learning__flowchip"
          title={tick ? `The newest scout tick and its gate outcome.${tick.detail ? ` ${tick.detail}` : ''}` : 'Scout records a row per tick (gate outcomes, ideas generated/routed) once tick observability lands — no ticks recorded yet.'}
        >
          <Radar size={11} aria-hidden />
          last tick <strong>{tick && !Number.isNaN(tickMs) ? whenLabel(tickMs) : 'none yet'}</strong>
          {tick?.outcome ? <em>{tick.outcome}</em> : null}
        </span>
      </div>

      <div className="pc-learning__scoreboard" aria-label="Scout summary">
        <Stat label="routed ideas" value={snap ? snap.totalRouted : '—'} hint="Ideas Scout has dispatched into a rail (plan draft, gym experiment, or work item) — its only output that counts." />
        {rails.map((r) => (
          <Stat key={r.rail} label={RAIL_META[r.rail]?.label ?? r.rail} value={r.count} tone="auto" hint={RAIL_META[r.rail]?.desc} />
        ))}
      </div>

      <div className="pc-learning__sectionhead">
        <h2>Routed ideas by rail</h2>
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
      ) : rails.length === 0 ? (
        <div className="pc-learning__empty pc-learning__empty--card">
          <Radar size={20} aria-hidden />
          <strong>Scout has not routed ideas yet</strong>
          <span>Scout sweeps the system on a cadence, but spends nothing unless its gates (idle, friction, budget, circuit-breaker) open — most ticks correctly do nothing. When an idea survives critique it’s routed into a plan draft, a gym experiment, or a work item, and it appears here.</span>
        </div>
      ) : (
        <ul className="pc-learning__list">
          {rails.map((r) => {
            const meta = RAIL_META[r.rail] ?? { label: r.rail, desc: 'Routed ideas', color: '#94a3b8' };
            return (
              <li key={r.rail} className="pc-learning__row" title={meta.desc}>
                <span className="pc-learning__sev" style={{ background: meta.color }} aria-hidden />
                <span className="pc-learning__id">{r.rail}</span>
                <span className="pc-learning__title">{meta.desc}</span>
                <span className="pc-learning__meta">
                  <span className="pc-learning__score" title="Ideas routed into this rail">{r.count}</span>
                </span>
              </li>
            );
          })}
        </ul>
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

      <div className="pc-learning__flow" aria-label="Memory health">
        <span
          className="pc-learning__flowchip"
          title="The shared canonical memory store agents recall from at session start."
        >
          <Brain size={11} aria-hidden />
          {memory ? <><strong>{memory.totalMemories}</strong> memories</> : <>memory health unavailable</>}
        </span>
        {memory ? (
          <span
            className="pc-learning__flowchip"
            title="Feedback events (edits, forgets, corrections) against memories in the trailing 30 days — zero means the store is written but never corrected."
          >
            <Activity size={11} aria-hidden />
            <strong>{memory.feedback30d}</strong> feedback events
            <em>30d</em>
          </span>
        ) : null}
      </div>

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
      .pc-learning__copy h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 20px; font-weight: 760; letter-spacing: -0.02em; color: var(--fg, #e7f7ff); }
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
      .pc-learning__subtab em { font-style: normal; font-size: 10px; font-weight: 500; color: var(--fg-mute, #7f9bb4); text-transform: uppercase; letter-spacing: 0.04em; }
      .pc-learning__subtab.is-active { color: var(--fg, #e7f7ff); border-color: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.12); }
      .pc-learning__subtab.is-active em { color: color-mix(in oklab, #34d399, white 12%); }

      .pc-learning__howtoggle {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 12px; font-size: 11.5px; font-weight: 600; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: transparent; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__howtoggle.is-on { color: var(--fg-dim, #b9d4e8); border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.07); }

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
      .pc-learning__flowchip em { font-style: normal; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__flownet { display: inline-flex; align-items: center; gap: 1px; font-weight: 740; font-variant-numeric: tabular-nums; }
      .pc-learning__flownet--good { color: #86efac; }
      .pc-learning__flownet--warn { color: #fcd34d; }
      .pc-learning__flownet--flat { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__flowchip--wd-good { border-color: rgba(52, 211, 153, 0.4); }
      .pc-learning__flowchip--wd-warn { border-color: rgba(252, 211, 77, 0.45); }
      .pc-learning__flowchip--wd-bad { border-color: rgba(248, 113, 113, 0.5); }
      .pc-learning__flowdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .pc-learning__flowdot--good { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
      .pc-learning__flowdot--warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
      .pc-learning__flowdot--bad { background: #f87171; box-shadow: 0 0 5px rgba(248, 113, 113, 0.6); }

      .pc-learning__scoreboard { display: flex; flex-wrap: wrap; gap: 8px; }
      .pc-learning__stat {
        display: flex; flex-direction: column; gap: 2px; min-width: 96px;
        padding: 9px 13px; border-radius: 10px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
      }
      .pc-learning__stat strong { font-size: 20px; font-weight: 760; line-height: 1; color: var(--fg, #e7f7ff); font-variant-numeric: tabular-nums; }
      .pc-learning__stat span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--fg-mute, #7f9bb4); }
      .pc-learning__stat--auto strong { color: #86efac; }
      .pc-learning__stat--human strong { color: #fcd34d; }
      .pc-learning__stat--good strong { color: #7dd3fc; }

      .pc-learning__section { display: flex; flex-direction: column; gap: 10px; }
      .pc-learning__sectionhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .pc-learning__sectionhead h2 { margin: 0; font-size: 13px; font-weight: 720; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-dim, #b9d4e8); }
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
      .pc-learning__loop em { font-style: normal; text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.05em; color: var(--fg-mute, #7f9bb4); }
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
      .pc-learning__delta--good { color: #86efac; }
      .pc-learning__delta--bad { color: #f87171; }
      .pc-learning__delta--flat { color: var(--fg-mute, #7f9bb4); }
      .pc-learning__age { font-size: 11px; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__score { font-size: 11px; font-weight: 700; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; min-width: 18px; text-align: right; }

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
