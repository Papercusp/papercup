/**
 * SignalsTab — the /adv "Signals" tab (owner ask 2026-07-10). Sits LEFT of
 * Learning.
 *
 * Signals is the system's self-measurement FUNNEL, in one place:
 *
 *   Observations  →  Ideas  →  Rubrics & Scorecards
 *   (raw turn-end     (ideation   (graded evidence +
 *    sensor readings)  proposals   trends over time)
 *                      + grades)
 *
 * Sub-views (nuqs `?sig=`):
 *   - **rubrics** (default): every rubric + its grading history — reuses the
 *     real RubricsPanel → RubricDetailPanel drill-down another agent built for
 *     the (now-removed) standalone /rubrics page. This replaces the erroring
 *     "Rubrics" top-navbar button that pointed at an unrouted /rubrics.
 *   - **observations**: the browse-only turn-end reflection feed
 *     (`learning.observations`) — the ObservationsPanel that had been buried
 *     inside the Create dock's view-switcher, surfaced here as its own home.
 *   - **ideas**: the ideation surface — routed ideas by rail + idea grading
 *     (Scout). This is MOVED here from the Learning tab's Scout sub-view (owner
 *     constraint: no duplication between Signals and Learning) — Learning now
 *     cross-links here instead of rendering it.
 *
 * All three read cross-pot (workspace-level) data, so Signals lives in
 * WORKSPACE_TAB_IDS and stays visible under "All Pots" like Learning.
 */
import { useState } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { Activity, Eye, Gauge, Lightbulb, type LucideIcon } from 'lucide-react';
import RubricsPanel from '@/app/_components/RubricsPanel';
import RubricDetailPanel from '@/app/_components/RubricDetailPanel';
import ObservationsPanel from '@/app/adv/create/ObservationsPanel';
// The ideation surface (routed ideas + idea grading) lives in Signals now, not
// Learning — imported from LearningTab so there is ONE implementation, never a
// fork. LearningStyles carries the `pc-learning__*` classes ScoutView uses.
import { ScoutView, LearningStyles } from './LearningTab';

const SIG_SUBS = ['rubrics', 'observations', 'ideas'] as const;
type SigSub = (typeof SIG_SUBS)[number];

const SUB_META: Record<SigSub, { label: string; blurb: string; icon: LucideIcon }> = {
  rubrics: { label: 'Rubrics & Scorecards', blurb: 'graded evidence + trends', icon: Gauge },
  observations: { label: 'Observations', blurb: 'raw turn-end sensor readings', icon: Eye },
  ideas: { label: 'Ideas', blurb: 'ideation proposals + grades', icon: Lightbulb },
};

export default function SignalsTab() {
  const [sig, setSig] = useQueryState(
    'sig',
    parseAsStringEnum<SigSub>([...SIG_SUBS]).withDefault('rubrics'),
  );
  const view: SigSub = (SIG_SUBS as readonly string[]).includes(sig) ? (sig as SigSub) : 'rubrics';
  // Rubrics drill-down is local UI state (rubric list → detail), mirroring the
  // old standalone /rubrics page.
  const [rubricId, setRubricId] = useState<string | null>(null);

  return (
    <div className="pc-signals">
      <header className="pc-signals__header">
        <div className="pc-signals__copy">
          <h1>
            <Activity size={18} aria-hidden /> Signals
          </h1>
          <p>
            The system’s self-measurement funnel: what agents <strong>notice</strong> (observations),
            what those become (<strong>ideas</strong> + how they’re graded), and how quality is{' '}
            <strong>measured</strong> over time (rubrics &amp; scorecards).
          </p>
        </div>
      </header>

      <div className="pc-signals__subnav" role="tablist" aria-label="Signals view">
        {SIG_SUBS.map((id) => {
          const m = SUB_META[id];
          const Icon = m.icon;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className={`pc-signals__subtab${view === id ? ' is-active' : ''}`}
              onClick={() => void setSig(id)}
            >
              <Icon size={13} aria-hidden />
              <span>
                {m.label}
                <em>{m.blurb}</em>
              </span>
            </button>
          );
        })}
      </div>

      <div className="pc-signals__body">
        {view === 'rubrics' ? (
          rubricId ? (
            <RubricDetailPanel rubricId={rubricId} onBack={() => setRubricId(null)} />
          ) : (
            <RubricsPanel onSelect={setRubricId} />
          )
        ) : view === 'observations' ? (
          <ObservationsPanel />
        ) : (
          // Ideas: the Scout ideation surface (routed ideas + grading), MOVED
          // from Learning. LearningStyles supplies its pc-learning__* classes.
          <>
            <LearningStyles />
            <ScoutView />
          </>
        )}
      </div>

      <SignalsStyles />
    </div>
  );
}

function SignalsStyles() {
  return (
    <style>{`
      .pc-signals { padding: 14px 18px 28px; color: var(--fg); }
      .pc-signals__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
      .pc-signals__copy h1 { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 650; margin: 0 0 4px; }
      .pc-signals__copy p { margin: 0; max-width: 720px; font-size: 12.5px; line-height: 1.5; color: var(--fg-mute); }
      .pc-signals__subnav { display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 14px; }
      .pc-signals__subtab {
        display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 12px;
        cursor: pointer; color: var(--fg-mute); background: var(--bg-1); border: 1px solid var(--border);
        border-radius: 7px; padding: 6px 11px; line-height: 1.25; transition: color .12s, border-color .12s, background .12s;
      }
      .pc-signals__subtab:hover { color: var(--fg); border-color: var(--fg-mute); }
      .pc-signals__subtab.is-active {
        color: var(--fg); border-color: var(--accent, #2dd4bf);
        background: color-mix(in srgb, var(--accent, #2dd4bf), transparent 88%);
      }
      .pc-signals__subtab span { display: inline-flex; flex-direction: column; align-items: flex-start; }
      .pc-signals__subtab em { font-style: normal; font-size: 10px; opacity: .7; }
      .pc-signals__body { min-height: 200px; }
    `}</style>
  );
}
