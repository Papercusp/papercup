/**
 * Calendar tab — the schedulable time-surface for scheduled/recurring plans
 * (scheduled-recurring-plans-2026-06-16 P-018/P-019). FullCalendar renders the
 * backend-computed occurrences (plans.scheduledOccurrences) for the visible
 * window — the rrule lib on the backend is the single source of truth, so the
 * calendar UI lib stays swappable (D-004). View + selection live in nuqs so the
 * surface is deep-linkable and agent-drivable (ui:dispatch).
 *
 * v1 renders + inspects. Drag-drop rescheduling + the RRULE recurrence editor are
 * P-020 (layered on top via the interaction plugin + plans:set-schedule).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { DatesSetArg, EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import type { DateClickArg } from '@fullcalendar/interaction';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import ScheduledRoutinesPane from './ScheduledRoutinesPane';
import ScheduleEditor, { runScheduleTool, type ScheduleMode } from './ScheduleEditor';
import './scheduled-calendar.css';

type CalView = 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay';

interface ScheduledOccurrenceRow {
  templateSlug: string;
  title: string | null;
  harnessSlug: string;
  occurrenceMs: number;
  kind: 'recurring' | 'one-shot';
  scheduleActive: boolean;
  lastOutcome: string | null;
}

/** The open schedule-editor target (P-020). */
interface EditorState {
  slug: string;
  title: string | null;
  /** ISO date the editor seeds on (from a day-click → one-shot). */
  seedDate?: string;
  seedMode?: ScheduleMode;
  isArmed: boolean;
}

/** The fields the "Schedule a plan" picker reads off plans.list (P-021 schedule glance). */
interface PlanListLite {
  slug: string;
  title: string | null;
  scheduled?: boolean;
  scheduleActive?: boolean;
  harness: string;
}

const VIEW_VALUES: CalView[] = ['dayGridMonth', 'timeGridWeek', 'timeGridDay'];

export default function ScheduledCalendarTab() {
  const calRef = useRef<FullCalendar | null>(null);
  const [view, setView] = useQueryState('calView', parseAsStringEnum<CalView>(VIEW_VALUES).withDefault('dayGridMonth'));
  const [selected, setSelected] = useQueryState('calPlan', parseAsString);
  // Visible window — set from FullCalendar's datesSet so the sync query tracks the view.
  const [range, setRange] = useState<{ startMs: number; endMs: number } | null>(null);

  const { data, loading, invalidate } = useSyncQuery<ScheduledOccurrenceRow>({
    queryName: 'plans.scheduledOccurrences',
    args: { rangeStartMs: range?.startMs ?? 0, rangeEndMs: range?.endMs ?? 0 },
    enabled: !!range,
  });
  const occurrences = useMemo(() => data ?? [], [data]);

  // ── Schedule editor + drag-drop (P-020) ──
  // The editor authors a plan's schedule (recurring RRULE or one-shot) via
  // plans:set-schedule and arms it via plans:arm-schedule. `null` = closed.
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The plan list (incl. P-021 schedule fields) powers the "Schedule a plan"
  // picker — pick an unscheduled plan to give it a first schedule.
  const { data: planListData } = useSyncQuery<PlanListLite>({ queryName: 'plans.list', args: {} });
  const planList = useMemo(() => (Array.isArray(planListData) ? planListData : []), [planListData]);
  const afterWrite = useCallback(() => void invalidate?.(), [invalidate]);

  const events: EventInput[] = useMemo(
    () =>
      occurrences.map((o) => ({
        id: `${o.templateSlug}:${o.occurrenceMs}`,
        title: o.title ?? o.templateSlug,
        start: new Date(o.occurrenceMs).toISOString(),
        extendedProps: o,
        classNames: [
          'pc-sched-event',
          o.scheduleActive ? 'pc-sched-event--armed' : 'pc-sched-event--paused',
          o.lastOutcome ? `pc-sched-event--${o.lastOutcome}` : '',
          o.kind === 'one-shot' ? 'pc-sched-event--oneshot' : '',
        ].filter(Boolean),
      })),
    [occurrences],
  );

  const onDatesSet = useCallback(
    (arg: DatesSetArg) => {
      setRange({ startMs: arg.start.getTime(), endMs: arg.end.getTime() });
      // Keep the URL view param in sync with FullCalendar's own toolbar.
      if (arg.view.type !== view && VIEW_VALUES.includes(arg.view.type as CalView)) {
        void setView(arg.view.type as CalView);
      }
    },
    [view, setView],
  );

  // URL → FullCalendar (agent ui:dispatch / deep link sets ?calView=).
  useEffect(() => {
    const api = calRef.current?.getApi();
    if (api && api.view.type !== view) api.changeView(view);
  }, [view]);

  const onEventClick = useCallback(
    (arg: EventClickArg) => {
      const slug = (arg.event.extendedProps as ScheduledOccurrenceRow).templateSlug;
      void setSelected(slug);
    },
    [setSelected],
  );

  // Click/drag onto a day = a one-shot for the SELECTED plan (P-020). With no
  // plan selected there's no target, so open the picker to choose one instead.
  const onDateClick = useCallback(
    (arg: DateClickArg) => {
      if (!selected) {
        setPickerOpen(true);
        return;
      }
      const row = occurrences.find((o) => o.templateSlug === selected);
      setEditor({
        slug: selected,
        title: row?.title ?? selected,
        seedDate: arg.date.toISOString(),
        seedMode: 'one-shot',
        isArmed: row?.scheduleActive ?? false,
      });
    },
    [selected, occurrences],
  );

  // Drag an event to a new day. A one-shot just moves (rewrite scheduledAt). A
  // recurring occurrence can't be moved in isolation without the source RRULE
  // (the occurrence row doesn't carry it), so revert + open the editor for an
  // edit-all — per-occurrence EXDATE+RDATE drag is a documented follow-on.
  const onEventDrop = useCallback(
    async (arg: EventDropArg) => {
      const o = arg.event.extendedProps as ScheduledOccurrenceRow;
      const newStart = arg.event.start;
      if (!newStart) {
        arg.revert();
        return;
      }
      if (o.kind === 'one-shot') {
        const r = await runScheduleTool('plans:set-schedule', {
          slug: o.templateSlug,
          schedule: null,
          scheduledAt: newStart.toISOString(),
        });
        if (!r.ok) arg.revert();
        else afterWrite();
      } else {
        arg.revert();
        setEditor({ slug: o.templateSlug, title: o.title, isArmed: o.scheduleActive });
      }
    },
    [afterWrite],
  );

  const selectedPlan = useMemo(() => {
    if (!selected) return null;
    const rows = occurrences.filter((o) => o.templateSlug === selected);
    if (rows.length === 0) return null;
    const now = Date.now();
    const upcoming = rows.filter((o) => o.occurrenceMs >= now).sort((a, b) => a.occurrenceMs - b.occurrenceMs);
    return { row: rows[0], upcoming: upcoming.slice(0, 5) };
  }, [selected, occurrences]);

  return (
    <div className="pc-sched-cal">
      <div className="pc-sched-cal__legend" aria-hidden>
        <span><i className="pc-sched-cal__swatch" style={{ background: 'var(--good, #34d399)' }} /> last run ok</span>
        <span><i className="pc-sched-cal__swatch" style={{ background: 'var(--bad, #fb7185)' }} /> last run failed</span>
        <span><i className="pc-sched-cal__swatch" style={{ background: 'var(--warn, #fbbf24)' }} /> partial</span>
        <span><i className="pc-sched-cal__swatch" style={{ background: 'var(--fg-mute, #7f9bb4)', opacity: 0.55 }} /> paused (disarmed)</span>
        <span style={{ fontStyle: 'italic' }}>italic = one-shot</span>
        {loading && <span>· loading…</span>}
        <button
          type="button"
          className="pc-sched-cal__add"
          onClick={() => setPickerOpen(true)}
          aria-hidden={false}
          title="Author a schedule for a plan"
        >
          ＋ Schedule a plan
        </button>
      </div>
      <div className="pc-sched-cal__body">
        <aside className="pc-sched-cal__routines">
          <ScheduledRoutinesPane onSelect={(slug) => void setSelected(slug)} />
        </aside>
        <div className="pc-sched-cal__main">
          <FullCalendar
            ref={calRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView={view}
            headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
            events={events}
            datesSet={onDatesSet}
            eventClick={onEventClick}
            dateClick={onDateClick}
            eventDrop={onEventDrop}
            editable
            eventStartEditable
            eventDurationEditable={false}
            height="100%"
            nowIndicator
            dayMaxEvents={4}
            firstDay={1}
          />
        </div>
        {selectedPlan && (
          <aside className="pc-sched-cal__aside">
            <h3>{selectedPlan.row.title ?? selectedPlan.row.templateSlug}</h3>
            <dl>
              <dt>Plan</dt>
              <dd>{selectedPlan.row.templateSlug}</dd>
              <dt>Pot</dt>
              <dd>{selectedPlan.row.harnessSlug}</dd>
              <dt>State</dt>
              <dd>{selectedPlan.row.scheduleActive ? 'Armed (firing)' : 'Paused (disarmed)'}</dd>
              <dt>Kind</dt>
              <dd>{selectedPlan.row.kind === 'one-shot' ? 'One-shot' : 'Recurring'}</dd>
              <dt>Last run</dt>
              <dd>{selectedPlan.row.lastOutcome ?? '—'}</dd>
            </dl>
            <h3>Next fires</h3>
            {selectedPlan.upcoming.length === 0 ? (
              <p className="pc-sched-cal__empty" style={{ padding: 8 }}>No upcoming occurrences in view.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 11 }}>
                {selectedPlan.upcoming.map((o) => (
                  <li key={o.occurrenceMs} style={{ padding: '2px 0', color: 'var(--fg-dim, #b9d4e8)' }}>
                    {new Date(o.occurrenceMs).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
            <p style={{ marginTop: 12 }}>
              <a href={`/adv?tab=plans&plan=${encodeURIComponent(selectedPlan.row.templateSlug)}`} style={{ color: 'var(--accent, #38bdf8)', fontSize: 11 }}>
                Open plan → runs &amp; schedule
              </a>
            </p>
            <button
              type="button"
              onClick={() => void setSelected(null)}
              style={{ marginTop: 8, fontSize: 11 }}
            >
              Close
            </button>
          </aside>
        )}
      </div>
    </div>
  );
}
