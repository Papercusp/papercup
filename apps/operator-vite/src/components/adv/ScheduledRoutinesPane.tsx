/**
 * Scheduled-routines pane (scheduled-recurring-plans-2026-06-16 P-026) — the ops view:
 * one row per scheduled plan with its next fire, armed/paused state, and last-run
 * outcome (health glance). Reads the same plans.scheduledOccurrences ledger as the
 * Calendar, over its OWN now→+30d window (so "next fire" is always the true upcoming
 * fire, independent of the calendar's visible range). Surfaced beside the Calendar; the
 * same component can be dropped into the Queen sidebar.
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { CalendarClock } from 'lucide-react';

interface ScheduledOccurrenceRow {
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  occurrenceMs: number;
  kind: 'recurring' | 'one-shot';
  scheduleActive: boolean;
  lastOutcome: string | null;
}

interface RoutineRow {
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  scheduleActive: boolean;
  lastOutcome: string | null;
  nextFireMs: number | null;
  kind: 'recurring' | 'one-shot';
}

const OUTCOME_LABEL: Record<string, string> = {
  success: 'Success',
  failed: 'Failed',
  partial: 'Partial',
};

function relWhen(ms: number | null): string {
  if (ms == null) return '—';
  const d = ms - Date.now();
  if (d < 0) return 'overdue';
  const min = Math.round(d / 60000);
  if (min < 60) return `in ${Math.max(1, min)}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export default function ScheduledRoutinesPane({ onSelect }: { onSelect?: (slug: string) => void }) {
  // A stable 30-day window. Date.now() is fine in a component (not a workflow script).
  const window = useMemo(() => {
    const now = Date.now();
    return { rangeStartMs: now, rangeEndMs: now + 30 * 24 * 60 * 60 * 1000 };
  }, []);

  const { data, loading } = useSyncQuery<ScheduledOccurrenceRow>({
    queryName: 'plans.scheduledOccurrences',
    args: window,
  });
  const occ = useMemo(() => data ?? [], [data]);

  const routines: RoutineRow[] = useMemo(() => {
    const byPlan = new Map<string, RoutineRow>();
    for (const o of occ) {
      const cur = byPlan.get(o.templateSlug);
      if (!cur) {
        byPlan.set(o.templateSlug, {
          templateSlug: o.templateSlug,
          title: o.title,
          harnessSlug: o.harnessSlug,
          scheduleActive: o.scheduleActive,
          lastOutcome: o.lastOutcome,
          nextFireMs: o.occurrenceMs,
          kind: o.kind,
        });
      } else if (o.occurrenceMs < (cur.nextFireMs ?? Infinity)) {
        cur.nextFireMs = o.occurrenceMs;
      }
    }
    // armed first, then soonest fire.
    return [...byPlan.values()].sort((a, b) => {
      if (a.scheduleActive !== b.scheduleActive) return a.scheduleActive ? -1 : 1;
      return (a.nextFireMs ?? Infinity) - (b.nextFireMs ?? Infinity);
    });
  }, [occ]);
  const activeCount = routines.filter((routine) => routine.scheduleActive).length;

  return (
    <div className="pc-routines">
      <div className="pc-routines__summary">
        <span>{routines.length} scheduled</span>
        <span>{activeCount} active</span>
      </div>
      {routines.length === 0 ? (
        <div className="pc-routines__empty">
          {loading ? 'Loading routines…' : 'No routines scheduled in the next 30 days.'}
        </div>
      ) : (
        <ul className="pc-routines__list">
          {routines.map((r) => (
            <li key={r.templateSlug} className="pc-routines__item" data-active={r.scheduleActive}>
              <button
                type="button"
                className="pc-routines__row"
                onClick={() => onSelect?.(r.templateSlug)}
                disabled={!onSelect}
                aria-label={onSelect ? `Open ${r.title ?? r.templateSlug}` : undefined}
              >
                <span className="pc-routines__topline">
                  <span className="pc-routines__title" title={r.templateSlug}>{r.title ?? r.templateSlug}</span>
                  <span className="pc-routines__state" data-active={r.scheduleActive}>
                    {r.scheduleActive ? 'Active' : 'Paused'}
                  </span>
                </span>
                <span className="pc-routines__meta">
                  <span className="pc-routines__next"><CalendarClock size={11} aria-hidden /> {relWhen(r.nextFireMs)}</span>
                  <span className="pc-routines__outcome" data-outcome={r.lastOutcome ?? 'none'}>
                    {r.lastOutcome ? `Last: ${OUTCOME_LABEL[r.lastOutcome] ?? r.lastOutcome}` : 'No runs yet'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <style>{ROUTINES_CSS}</style>
    </div>
  );
}

const ROUTINES_CSS = `
  .pc-routines { display: flex; flex-direction: column; gap: 7px; min-height: 0; color: var(--fg, #e7f7ff); }
  .pc-routines__summary { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--fg-mute, #7f9bb4); }
  .pc-routines__empty { padding: 14px 8px; text-align: center; font-size: 11px; color: var(--fg-mute, #7f9bb4); border: 1px dashed var(--border, rgba(125,211,252,0.15)); border-radius: 8px; }
  .pc-routines__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; overflow-y: auto; }
  .pc-routines__item { margin: 0; }
  .pc-routines__row { width: 100%; display: flex; flex-direction: column; gap: 5px; padding: 8px 9px; text-align: left; color: inherit; background: var(--bg-2, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(125,211,252,0.15)); border-radius: 8px; cursor: pointer; }
  .pc-routines__row:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent), transparent 55%); background: color-mix(in srgb, var(--accent), transparent 94%); }
  .pc-routines__row:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
  .pc-routines__row:disabled { cursor: default; opacity: 1; }
  .pc-routines__topline, .pc-routines__meta { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .pc-routines__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; font-weight: 700; }
  .pc-routines__state, .pc-routines__outcome { flex-shrink: 0; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); font-size: 9px; font-weight: 700; color: var(--fg-mute); }
  .pc-routines__state[data-active='true'] { color: var(--good); border-color: color-mix(in srgb, var(--good), transparent 58%); background: color-mix(in srgb, var(--good), transparent 92%); }
  .pc-routines__meta { justify-content: space-between; color: var(--fg-mute, #7f9bb4); font-size: 9.5px; }
  .pc-routines__next { display: inline-flex; align-items: center; gap: 4px; }
  .pc-routines__outcome[data-outcome='success'] { color: var(--good); }
  .pc-routines__outcome[data-outcome='failed'] { color: var(--bad); }
  .pc-routines__outcome[data-outcome='partial'] { color: var(--warn); }
`;
