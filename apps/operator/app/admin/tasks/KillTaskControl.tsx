'use client';

import { useCallback, useState, type ReactElement } from 'react';
import { useSyncMutate } from '@papercusp/sync';

// `@/app/...` (not a relative path): this component is rendered from BOTH trees —
// apps/operator's /admin/tasks page and operator-vite's AdvShell dropdown — and the
// alias is the form both resolve. Same reason use-resource-totals is imported that way.
import { Button } from '@/app/harness/Button';

/**
 * KillTaskControl — the ONE kill control, used by both task-manager surfaces
 * (task-manager-no-escape-2026-07-27 P-023/P-024/P-025; owner ask 2026-08-08:
 * "there should be a way to kill processes in both the dropdown and the full page view").
 *
 * ⚠ IT IS DELIBERATELY ONE COMPONENT, NOT TWO. The dropdown
 * (operator-vite TasksRosterPanel) and the full page (TasksClient, which also serves the
 * left-rail Tasks tab) both mount THIS. Two kill buttons with independently-written
 * enable rules is exactly how a destructive control drifts: one surface learns that a
 * `stranded` row is not ours to signal and the other keeps offering it, and the
 * difference is invisible until someone signals a stranger. The enable rule and the
 * refusal copy live here once.
 *
 * WHAT IT CAN REACH. It posts a `taskId` and nothing else. There is no pid field and no
 * name/pattern field, by construction — `pkill -f '<binary>'` has twice taken out the
 * owner's live desktop on this box, so "looks like mine" is never an input here. The
 * server delegates to `killTask`, which signals either the row's CGROUP SCOPE (the whole
 * subtree, unreachable by a recycled pid) or a pid it has just re-verified against the
 * kernel identity the row recorded. A mismatch REFUSES.
 *
 * WHY REFUSALS ARE RENDERED VERBATIM (P-025). `identity_mismatch` is the rail WORKING —
 * the pid wrapped and we declined to signal whatever holds it now. Swallowing that into
 * a generic "couldn't kill" teaches the reader to click again, which is the one response
 * that is actually dangerous. So the error code and the server's own detail string are
 * shown as-is, with a sentence saying which of the two it is.
 */

/** ControlError from task-manager/control.ts, plus the transport-level ones this adds. */
export type KillRefusal =
  | 'task_not_found'
  | 'not_live'
  | 'identity_mismatch'
  | 'no_target'
  | 'unsupported'
  | 'command_failed'
  | 'disabled'
  | 'bad_request';

export type KillOutcome = {
  ok: boolean;
  taskId?: string;
  action?: string;
  error?: KillRefusal | string;
  detail?: string;
};

/** The row fields the enable rule reads. Structural on purpose — both panes carry
 *  their own row type and neither should have to import the other's. */
export type KillableRow = {
  taskId: string;
  state: string;
  confined: boolean;
  scopeUnit: string | null;
  title?: string;
};

/**
 * States that assert a live OS process we OWN and may therefore signal.
 *
 * ⚠ This MIRRORS `isLiveOwnedState` in task-manager/types.ts and does not import it,
 * because that module is server-side and pulling it into the SPA's browser-eager graph
 * is the white-screen class `inventory-shared.ts` was split out to close (WI-8191).
 * The duplication is asserted in the test rather than assumed: keeping the two in step
 * matters more than saving four characters, and the SERVER is authoritative regardless —
 * a UI that offered a kill on a state the server rejects gets an honest `not_live` back.
 */
const LIVE_OWNED_STATES = new Set(['pending', 'running']);

/**
 * Can this row be signalled, and if not, WHY — in words a reader can act on.
 *
 * Pure, exported, and the single source for both surfaces' disabled state. The `reason`
 * is never empty: a disabled destructive control with no explanation reads as a bug in
 * the pane, and the reader's next move is a shell.
 */
export function killability(row: KillableRow): { killable: boolean; reason: string } {
  if (!LIVE_OWNED_STATES.has(row.state)) {
    return {
      killable: false,
      // A residue/terminal row is not ours to signal — the process it describes has
      // already ended, or was never ours (D-010). Killing on it would either no-op or,
      // worse, reach a recycled pid.
      reason: `state is “${row.state}” — only a running or pending task is ours to signal`,
    };
  }
  if (!row.confined && !row.scopeUnit) {
    // Still allowed: killTask falls back to the identity-verified pid path. Say so, so
    // the reader knows this one signals a pid rather than a whole cgroup subtree.
    return { killable: true, reason: 'unconfined — signals the verified pid, not a cgroup subtree' };
  }
  return { killable: true, reason: `kills the whole ${row.scopeUnit ?? 'cgroup'} subtree` };
}

/** One sentence of context per refusal code. Pure, exported for the tests. */
export function refusalHelp(error: string | undefined): string {
  switch (error) {
    case 'identity_mismatch':
      return 'The pid was recycled — this is the safety rail working, not a failure. Nothing was signalled.';
    case 'not_live':
      return 'The task already ended, or it is residue we do not own.';
    case 'task_not_found':
      return 'No ledger row with that id — it may have been closed out by the reconciler.';
    case 'unsupported':
      return 'This task has no cgroup scope, so that verb does not apply to it.';
    case 'no_target':
      return 'The row records neither a scope nor a usable pid, so there is nothing to signal.';
    case 'disabled':
      return 'The task manager is switched off at /admin/features; nothing is being confined or signalled.';
    case 'command_failed':
      return 'systemd refused the signal — the detail below is its own message.';
    default:
      return '';
  }
}

async function killTaskRest(args: { taskId: string }): Promise<KillOutcome> {
  const res = await fetch('/api/admin/tasks/kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  // A 4xx/5xx still carries our JSON body; read it rather than throwing away the reason.
  try {
    return (await res.json()) as KillOutcome;
  } catch {
    return { ok: false, error: 'command_failed', detail: `HTTP ${res.status}` };
  }
}

export default function KillTaskControl({
  row,
  onKilled,
}: {
  row: KillableRow;
  /** Fired after a SUCCESSFUL kill, so a pane can nudge its own read. The route already
   *  invalidates `taskManager.inventory`; this is for anything a surface keeps locally. */
  onKilled?: (taskId: string) => void;
}): ReactElement {
  // Ephemeral lifecycle, NOT nuqs: an armed confirm and an in-flight request are
  // mid-interaction state that must never survive a reload or be deep-linkable —
  // a URL that arrives pre-armed to kill something is the opposite of a confirm step.
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<KillOutcome | null>(null);

  const mutate = useSyncMutate<{ taskId: string }, KillOutcome>('taskManager.kill', killTaskRest);
  const { killable, reason } = killability(row);

  const fire = useCallback(async () => {
    setPending(true);
    setOutcome(null);
    try {
      const res = await mutate({ taskId: row.taskId });
      setOutcome(res);
      if (res.ok) onKilled?.(row.taskId);
    } catch (e) {
      setOutcome({ ok: false, error: 'command_failed', detail: String(e) });
    } finally {
      setPending(false);
      setArmed(false);
    }
  }, [mutate, row.taskId, onKilled]);

  if (outcome && !outcome.ok) {
    const help = refusalHelp(outcome.error);
    return (
      <span className="pc-task-kill is-refused" data-testid={`task-kill-refused-${row.taskId}`} role="alert">
        <strong>refused: {outcome.error ?? 'unknown'}</strong>
        {help && <span className="pc-task-kill__help"> {help}</span>}
        {/* VERBATIM — the server's own words. It names the pid, the identity it found and
            the one the row recorded, which is what makes the refusal checkable. */}
        {outcome.detail && <span className="pc-task-kill__detail"> {outcome.detail}</span>}{' '}
        <Button size="mini" variant="ghost" onClick={() => setOutcome(null)} data-testid={`task-kill-dismiss-${row.taskId}`}>
          dismiss
        </Button>
      </span>
    );
  }

  if (outcome?.ok) {
    return (
      <span className="pc-task-kill is-done" data-testid={`task-kill-done-${row.taskId}`}>
        signalled{outcome.detail ? ` · ${outcome.detail}` : ''}
      </span>
    );
  }

  if (!killable) {
    return (
      // `title` AND visible text, because in the 620px dropdown there is no room for the
      // sentence but a hover still has to answer "why can't I stop this one".
      <Button size="mini" variant="ghost" disabled title={reason} data-testid={`task-kill-disabled-${row.taskId}`}>
        —
      </Button>
    );
  }

  if (armed) {
    return (
      <span className="pc-task-kill is-armed" data-testid={`task-kill-confirm-${row.taskId}`}>
        <span className="pc-task-kill__ask">kill? {reason}</span>{' '}
        <Button
          size="mini"
          variant="destructive"
          disabled={pending}
          onClick={() => void fire()}
          data-testid={`task-kill-yes-${row.taskId}`}
        >
          {pending ? 'killing…' : 'confirm'}
        </Button>{' '}
        <Button size="mini" variant="ghost" disabled={pending} onClick={() => setArmed(false)} data-testid={`task-kill-no-${row.taskId}`}>
          cancel
        </Button>
      </span>
    );
  }

  return (
    <Button
      size="mini"
      variant="destructive"
      title={reason}
      onClick={() => setArmed(true)}
      data-testid={`task-kill-${row.taskId}`}
      aria-label={`kill ${row.title || row.taskId}`}
    >
      kill
    </Button>
  );
}
