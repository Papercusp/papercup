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

const OUTCOME_COLOR: Record<string, string> = {
  success: 'var(--good, #34d399)',
  failed: 'var(--bad, #fb7185)',
  partial: 'var(--warn, #fbbf24)',
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--fg, #e7f7ff)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>Scheduled plans</span>
        <span style={{ color: 'var(--fg-mute, #7f9bb4)', fontWeight: 400 }}>{routines.length}</span>
      </div>
      {routines.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--fg-mute, #7f9bb4)', padding: 8 }}>
          {loading ? 'loading…' : 'No scheduled plans in the next 30 days.'}
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto' }}>
          {routines.map((r) => (
            <li
              key={r.templateSlug}
              onClick={() => onSelect?.(r.templateSlug)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 6px',
                borderBottom: '1px solid var(--border-muted, rgba(125,211,252,0.08))',
                cursor: onSelect ? 'pointer' : 'default',
                opacity: r.scheduleActive ? 1 : 0.6,
              }}
            >
              <span
                title={r.scheduleActive ? 'armed' : 'paused'}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: r.scheduleActive ? 'var(--good, #34d399)' : 'var(--fg-mute, #7f9bb4)',
                }}
              />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                {r.title ?? r.templateSlug}
              </span>
              {r.lastOutcome && (
                <span
                  title={`last run: ${r.lastOutcome}`}
                  style={{ width: 7, height: 7, borderRadius: 2, flexShrink: 0, background: OUTCOME_COLOR[r.lastOutcome] ?? 'var(--fg-mute, #7f9bb4)' }}
                />
              )}
              <span style={{ fontSize: 10, color: 'var(--fg-mute, #7f9bb4)', flexShrink: 0, width: 52, textAlign: 'right' }}>
                {relWhen(r.nextFireMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
