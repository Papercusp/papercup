/**
 * LearningTab — the /adv "Learning" tab (operator-learning-tab-2026-06-09).
 *
 * A PULL surface for everything the system learns about itself. It replaces the
 * old `improvement-digest` inbox PUSH notification (a dead-end the owner couldn't
 * click through, D-001): instead of being pinged, the owner opens this tab.
 *
 * Section A — Improvements (live): the captured `papercusp-improvement` backlog,
 * read through the `learning.improvements` sync resolver, which reuses the SAME
 * readImprovementItems + buildDigest path the `improvements:digest` tool uses (so
 * the tab and the tool never drift, D-003). A scoreboard strip over the digest
 * rollups, then the two triage lanes — auto-eligible (kind=bug, safe surface) vs
 * needs-a-human — each row showing severity, age, idea-type, and score.
 *
 * Sections B (gym experiments), C (the IQ-battery benchmark scoreboard) and D
 * (agent insights) land in later phases as those pipelines produce data.
 *
 * All user-meaningful state is in the URL via nuqs (CLAUDE.md); only the sync
 * lifecycle is implicit. Styled with the shared app tokens (--fg/--accent/…),
 * matching AdvShell + AdvConversationsTab.
 */
import { useMemo } from 'react';
import { useQueryState, parseAsStringEnum } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { GraduationCap, RefreshCw, ShieldCheck, UserRound, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { ImprovementDigest, ScoredItem } from '@papercusp/operator-core/lib/harness/improvements/digest';

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

export default function LearningTab() {
  const sync = useSyncQuery<ImprovementDigest>({
    queryName: 'learning.improvements',
    args: {},
    staleTime: 30_000,
  });
  const digest = sync.data?.[0];
  const [lane, setLane] = useQueryState('lane', parseAsStringEnum<Lane>([...LANES]).withDefault('all'));

  const rows = useMemo<ScoredItem[]>(() => {
    if (!digest) return [];
    if (lane === 'auto') return digest.autoEligible;
    if (lane === 'human') return digest.humanQueue;
    // 'all' — auto lane first (actionable), then the human queue, highest score within each.
    return [...digest.autoEligible, ...digest.humanQueue];
  }, [digest, lane]);

  const resolved = digest?.byState?.resolved ?? 0;

  return (
    <div className="pc-learning">
      <header className="pc-learning__header">
        <div className="pc-learning__copy">
          <h1>
            <GraduationCap size={18} aria-hidden /> Learning
          </h1>
          <p>How the system improves itself — what it noticed, captured, and fixed. The pull-view that replaced the digest notification.</p>
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
      </header>

      {/* Scoreboard strip — the digest rollups */}
      <div className="pc-learning__scoreboard" aria-label="Improvements summary">
        <Stat label="captured" value={digest?.total ?? '—'} />
        <Stat label="open" value={digest?.open ?? '—'} />
        <Stat label="auto-eligible" value={digest?.autoEligible.length ?? '—'} tone="auto" />
        <Stat label="needs a human" value={digest?.humanQueue.length ?? '—'} tone="human" />
        <Stat label="resolved" value={resolved} tone="good" />
      </div>

      {/* Section A — Improvements */}
      <section className="pc-learning__section">
        <div className="pc-learning__sectionhead">
          <h2>Improvements the system captured</h2>
          <div className="pc-learning__lanes" role="tablist" aria-label="Triage lane">
            {LANES.map((l) => (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={lane === l}
                className={`pc-learning__lane${lane === l ? ' is-active' : ''}`}
                onClick={() => void setLane(l)}
              >
                {l === 'all' ? 'All' : l === 'auto' ? 'Auto-eligible' : 'Needs a human'}
              </button>
            ))}
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

      <p className="pc-learning__footnote">
        Gym experiments, the IQ-battery benchmark, and agent insights will join this view as those pipelines produce data.
      </p>

      <LearningStyles />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'auto' | 'human' | 'good' }) {
  return (
    <div className={`pc-learning__stat${tone ? ` pc-learning__stat--${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
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
        <span className={`pc-learning__chip pc-learning__chip--${human ? 'human' : 'auto'}`}>
          {human ? <UserRound size={10} aria-hidden /> : <ShieldCheck size={10} aria-hidden />}
          {human ? 'human' : 'auto'}
        </span>
        <span className="pc-learning__age">{ageLabel(item.ageDays)}</span>
        <span className="pc-learning__score" title="triage score (severity + age)">{item.score}</span>
      </span>
    </li>
  );
}

function LearningStyles() {
  return (
    <style>{`
      .pc-learning { display: flex; flex-direction: column; min-height: 0; padding: 14px 16px 20px; gap: 14px; overflow-y: auto; }
      .pc-learning__header { display: flex; align-items: flex-start; gap: 12px; }
      .pc-learning__copy { flex: 1; min-width: 0; }
      .pc-learning__copy h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 20px; font-weight: 760; letter-spacing: -0.02em; color: var(--fg, #e7f7ff); }
      .pc-learning__copy p { margin: 4px 0 0; font-size: 12.5px; color: var(--fg-mute, #7f9bb4); max-width: 70ch; }
      .pc-learning__refresh {
        display: inline-flex; align-items: center; justify-content: center;
        width: 30px; height: 30px; flex-shrink: 0;
        border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
        border-radius: 8px; background: var(--bg-popover, #0d1829); color: var(--fg-dim, #b9d4e8); cursor: pointer;
      }
      .pc-learning__refresh:disabled { opacity: 0.5; cursor: default; }

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
      .pc-learning__lanes { display: inline-flex; gap: 4px; }
      .pc-learning__lane {
        padding: 4px 10px; font-size: 11px; font-weight: 650; border-radius: 999px; cursor: pointer;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.18));
        background: transparent; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__lane.is-active { color: var(--fg, #e7f7ff); border-color: rgba(125, 211, 252, 0.5); background: rgba(125, 211, 252, 0.12); }

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
      .pc-learning__meta { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
      .pc-learning__chip {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 1px 7px; font-size: 10px; font-weight: 600; text-transform: lowercase;
        border-radius: 999px; border: 1px solid currentColor; color: var(--fg-mute, #7f9bb4);
      }
      .pc-learning__chip--idea { color: #a78bfa; border-color: rgba(167, 139, 250, 0.5); }
      .pc-learning__chip--auto { color: #86efac; border-color: rgba(134, 239, 172, 0.5); }
      .pc-learning__chip--human { color: #fcd34d; border-color: rgba(252, 211, 77, 0.5); }
      .pc-learning__age { font-size: 11px; color: var(--fg-mute, #7f9bb4); white-space: nowrap; }
      .pc-learning__score { font-size: 11px; font-weight: 700; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; min-width: 18px; text-align: right; }

      .pc-learning__empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 28px 16px; color: var(--fg-mute, #7f9bb4); font-size: 12.5px; }
      .pc-learning__empty--card { border: 1px dashed var(--border, rgba(125, 211, 252, 0.2)); border-radius: 12px; }
      .pc-learning__empty strong { color: var(--fg-dim, #b9d4e8); font-size: 13px; }
      .pc-learning__empty span { max-width: 56ch; }

      .pc-learning__footnote { margin: 2px 0 0; font-size: 11px; font-style: italic; color: var(--fg-mute, #7f9bb4); }
    `}</style>
  );
}
