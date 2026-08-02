/**
 * TasksRunningPill — the Task Manager's always-visible header control
 * (WI-6844, owner ask 2026-08-02: "move the location of it from the middle pane
 * to a button on our top bar to the right of the 'agents running' button").
 *
 * Third pill in `pc-advshell__header-status`, after HivesRunningPill and
 * AgentsRunningPill. Modelled on HivesRunningPill rather than AgentsRunningPill:
 * both are Popover-over-a-pill, but the hives one is the 65-line version that has
 * not accreted a roster, a search box and a bulk-action bar, and this pill's job
 * is only to open the panel.
 *
 * ── Why the pill says "tasks" and the panel says "processes" ──
 * These are two different numbers and the wording is deliberate, because making
 * them LOOK like one number is the actual trap here (compare AdvOverviewTab's
 * note about the Agents tile never being allowed to disagree with the agents
 * pill — that only works because both read one query).
 *
 *   pill  → `summary.total`, the LEDGER: tasks the three enrolling seams
 *           registered. Cheap; no kernel scan.
 *   panel → `liveProcesses`, the SCAN: every process actually running, enrolled
 *           or not (WI-6475 added this precisely because the pane showed an empty
 *           table beside "400 process(es) scanned", which reads as broken).
 *
 * The ledger count is strictly smaller until P-009 enrols the remaining sidecar
 * spawners, so labelling both "processes" would present a known undercount as a
 * process total. Two words, two numbers, no false agreement. Follow-up WI tracks
 * giving the resolver a cheap counts-only live arm so the pill can show the true
 * process total without a kernel scan on every tab.
 *
 * The panel is lazy: it is the thing that carries the scan, and it must not run
 * for a popover nobody has opened.
 */
import { Suspense } from 'react';
// lazyWithRetry, NOT React's bare `lazy` (WI-2902, and re-learned the hard way here).
// A dynamic import that 404s escalates to the FATAL error boundary, and on this box
// the dist bundle is rebuilt every few minutes under a live window — every rebuild
// rotates the chunk hashes and deletes the old ones, so an open view that lazily
// imports a chunk mid-rebuild gets "Importing a module script failed."
//
// That hazard is much worse HERE than it was in the component's old home. As a
// left-rail tab this panel only mounted when someone opened that tab; as a header
// pill it mounts on EVERY AdvShell tab, so a single missed chunk fetch takes down
// the whole shell rather than one pane. Retrying is what turns that into a blip.
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { Activity } from 'lucide-react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Popover } from '@/app/harness/Popover';
import './adv-header-pills.css';

const TasksRosterPanel = lazy(() => import('./TasksRosterPanel'));

/** The slice of `taskManager.inventory` this pill needs — the cheap arm only. */
type PillPayload = {
  enabled: boolean;
  summary: { total: number; byState: Record<string, number>; byClass: Record<string, number> };
};

/** Running-ish states, i.e. what is still in flight. Pure — exported for the test. */
export function countActive(byState: Record<string, number> | undefined): number {
  if (!byState) return 0;
  return (byState.running ?? 0) + (byState.starting ?? 0);
}

export default function TasksRunningPill() {
  const [open, setOpen] = useQueryState('tasks', parseAsBoolean.withDefault(false));
  // No `live: true` — that arm walks the cgroup tree, and this pill is mounted on
  // every tab. The panel asks for the live view; this asks only for the ledger.
  const { data } = useSyncQuery<PillPayload>({
    queryName: 'taskManager.inventory',
    args: {},
    staleTime: 10_000,
  });

  const payload = (data as PillPayload[] | undefined)?.[0];

  // Self-hide like its two neighbours, so the strip grows no empty chrome. Two
  // reasons to say nothing: the kill-switch is pulled (the flag survives
  // graduation precisely so it can be), or the ledger is genuinely empty.
  if (!payload?.enabled) return null;
  const active = countActive(payload.summary?.byState);
  if (active === 0) return null;

  return (
    <div className="pc-advshell__tasks-pill-wrap">
      <Popover
        open={open}
        onOpenChange={(next) => void setOpen(next)}
        trigger={(
          <button
            type="button"
            className="pc-advshell__action pc-advshell__action--tasks"
            data-testid="tasks-running-pill"
            aria-expanded={open}
            aria-controls="pc-advshell-tasks-pop"
          >
            <Activity size={11} aria-hidden />
            {active} {active === 1 ? 'task' : 'tasks'}
          </button>
        )}
        tooltipLabel="Every task this operator launched — who started it, for which work-item, and what it costs"
        side="bottom"
        align="end"
        ariaLabel="Task manager"
        contentClassName="pc-advshell__tasks-pop"
      >
        <div id="pc-advshell-tasks-pop" data-testid="tasks-running-pop">
          <Suspense fallback={<div className="pc-tasks-roster__loading">Scanning…</div>}>
            {/* `open` gates the scan a second time: Popover keeps content mounted
                across a close on some paths, and a kernel scan must not outlive
                the popover that asked for it. */}
            <TasksRosterPanel active={open} />
          </Suspense>
        </div>
      </Popover>
    </div>
  );
}
