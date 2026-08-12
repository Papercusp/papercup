// @vitest-environment jsdom
/**
 * KillTaskControl — the ONE kill control both task-manager surfaces mount
 * (task-manager-no-escape-2026-07-27 P-023/P-024/P-025).
 *
 * What is actually worth asserting here is not "the button renders". It is the three
 * properties that make a destructive control in a dashboard safe, each of which has a
 * real incident behind it on this box:
 *
 *   1. IT CANNOT FIRE ON ONE CLICK. A confirm step, and the first click must send
 *      NOTHING — an accidental brush past a row is not consent.
 *   2. IT REFUSES ROWS THAT ARE NOT OURS TO SIGNAL, with a reason. A `stranded` or
 *      terminal row describes a process that already ended; offering a kill there
 *      invites signalling a recycled pid.
 *   3. A REFUSAL IS SHOWN VERBATIM. `identity_mismatch` is the safety rail working,
 *      and a control that reports it as a generic failure teaches the reader to click
 *      again — the one response that is genuinely dangerous.
 *
 * Plus the LIVE_OWNED_STATES duplication guard: the enable rule mirrors
 * `isLiveOwnedState` in task-manager/types.ts rather than importing it (that module is
 * server-side; pulling it into the SPA's eager graph is the WI-8191 white-screen class).
 * A mirrored constant that nothing checks is a divergence waiting to happen, so the
 * mirror is asserted against the real source's own text here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

const H = vi.hoisted(() => ({
  calls: [] as unknown[],
  reply: { ok: true, detail: 'scope pc-t1.scope signalled SIGTERM' } as unknown,
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncMutate: (_path: string, _rest: unknown) => async (args: unknown) => {
    H.calls.push(args);
    return H.reply;
  },
}));

import KillTaskControl, {
  KillOutcomeProvider,
  killability,
  refusalHelp,
  useKillOutcomeHoist,
  type KillableRow,
} from './KillTaskControl';

/** Resolve a repo-root-relative path by walking up from the run cwd. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const p = join(dir, rel);
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate ${rel} from ${process.cwd()}`);
}

const row = (over: Partial<KillableRow> = {}): KillableRow => ({
  taskId: 't1',
  state: 'running',
  confined: true,
  scopeUnit: 'pc-t1.scope',
  title: 'agent session',
  ...over,
});

afterEach(() => {
  cleanup();
  H.calls = [];
  H.reply = { ok: true, detail: 'scope pc-t1.scope signalled SIGTERM' };
});

describe('killability — the enable rule, shared by both surfaces', () => {
  it('allows a running confined task and names the subtree it takes', () => {
    const v = killability(row());
    expect(v.killable).toBe(true);
    expect(v.reason).toContain('pc-t1.scope');
  });

  it('allows a pending task — enrolment binds at spawn, before the process is up', () => {
    expect(killability(row({ state: 'pending' })).killable).toBe(true);
  });

  it.each(['exited', 'killed', 'timed_out', 'stranded', 'unaccounted', 'foreign'])(
    'refuses %s — a residue or terminal row is never ours to signal',
    (state) => {
      const v = killability(row({ state }));
      expect(v.killable).toBe(false);
      // The reason must NAME the state; "disabled" with no why reads as a broken pane
      // and sends the reader to a shell, which is where pkill lives.
      expect(v.reason).toContain(state);
    },
  );

  it('allows an unconfined task but says it signals a pid, not a subtree', () => {
    const v = killability(row({ confined: false, scopeUnit: null }));
    expect(v.killable).toBe(true);
    expect(v.reason).toMatch(/pid/);
  });

  it('never returns an empty reason, in either direction', () => {
    for (const state of ['running', 'pending', 'exited', 'stranded']) {
      expect(killability(row({ state })).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('the mirrored live-owned states stay in step with the server', () => {
  it('matches isLiveOwnedState in task-manager/types.ts', () => {
    // Read the SOURCE rather than importing it: importing that module is exactly the
    // client-graph leak the mirror exists to avoid, so the guard must not re-open it.
    // Walk UP from the run cwd rather than from `import.meta.url`: this suite runs under
    // jsdom, where `import.meta.url` is not a `file:` URL and `fileURLToPath` throws.
    // Throwing when the file is not found is deliberate — a guard that silently cannot
    // find its subject passes forever while checking nothing.
    const src = readFileSync(repoFile('packages/operator-core/lib/task-manager/types.ts'), 'utf8');
    const body = /export function isLiveOwnedState[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    expect(body).toContain("state === 'pending'");
    expect(body).toContain("state === 'running'");
    // If a THIRD live-owned state is ever added, this fails and the mirror gets updated
    // instead of silently under-offering the control.
    expect(body.match(/state === '/g)).toHaveLength(2);
  });
});

describe('confirm-before-fire', () => {
  it('sends nothing on the first click — it only arms', () => {
    render(<KillTaskControl row={row()} />);
    fireEvent.click(screen.getByTestId('task-kill-t1'));
    expect(H.calls).toEqual([]);
    expect(screen.getByTestId('task-kill-confirm-t1')).toBeTruthy();
  });

  it('fires with the taskId — and ONLY the taskId — on confirm', async () => {
    render(<KillTaskControl row={row()} />);
    fireEvent.click(screen.getByTestId('task-kill-t1'));
    fireEvent.click(screen.getByTestId('task-kill-yes-t1'));
    await screen.findByTestId('task-kill-done-t1');
    // No pid, no name, no pattern: the payload cannot express "looks like mine".
    expect(H.calls).toEqual([{ taskId: 't1' }]);
  });

  it('cancel disarms and sends nothing', () => {
    render(<KillTaskControl row={row()} />);
    fireEvent.click(screen.getByTestId('task-kill-t1'));
    fireEvent.click(screen.getByTestId('task-kill-no-t1'));
    expect(H.calls).toEqual([]);
    expect(screen.queryByTestId('task-kill-confirm-t1')).toBeNull();
    expect(screen.getByTestId('task-kill-t1')).toBeTruthy();
  });

  it('calls onKilled only after a SUCCESSFUL kill', async () => {
    const onKilled = vi.fn();
    H.reply = { ok: false, error: 'identity_mismatch', detail: 'pid 42 is gone' };
    render(<KillTaskControl row={row()} onKilled={onKilled} />);
    fireEvent.click(screen.getByTestId('task-kill-t1'));
    fireEvent.click(screen.getByTestId('task-kill-yes-t1'));
    await screen.findByTestId('task-kill-refused-t1');
    expect(onKilled).not.toHaveBeenCalled();
  });
});

describe('a row that is not ours to signal', () => {
  it('renders a disabled control carrying the reason on hover', () => {
    render(<KillTaskControl row={row({ state: 'stranded' })} />);
    const btn = screen.getByTestId('task-kill-disabled-t1') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('stranded');
    expect(screen.queryByTestId('task-kill-t1')).toBeNull();
  });
});

describe('refusals are surfaced verbatim (P-025)', () => {
  it('shows the code, the server detail, and what it means', async () => {
    H.reply = {
      ok: false,
      error: 'identity_mismatch',
      detail: 'pid 4242 now holds identity 991:44, row recorded 812:17 — refusing to signal a recycled pid',
    };
    render(<KillTaskControl row={row()} />);
    fireEvent.click(screen.getByTestId('task-kill-t1'));
    fireEvent.click(screen.getByTestId('task-kill-yes-t1'));
    const el = await screen.findByTestId('task-kill-refused-t1');
    expect(el.textContent).toContain('identity_mismatch');
    // VERBATIM — the pid and both identities are what make the refusal checkable.
    expect(el.textContent).toContain('row recorded 812:17');
    // …and the interpretation, so a correct refusal is not read as a broken button.
    expect(el.textContent).toContain('safety rail working');
    expect(el.getAttribute('role')).toBe('alert');
  });

  it('a refusal can be dismissed back to an armable control, not left stuck', async () => {
    H.reply = { ok: false, error: 'not_live', detail: 'state is exited' };
    render(<KillTaskControl row={row()} />);
    fireEvent.click(screen.getByTestId('task-kill-t1'));
    fireEvent.click(screen.getByTestId('task-kill-yes-t1'));
    await screen.findByTestId('task-kill-refused-t1');
    fireEvent.click(screen.getByTestId('task-kill-dismiss-t1'));
    expect(screen.getByTestId('task-kill-t1')).toBeTruthy();
  });

  it('every ControlError the server can return has help text', () => {
    for (const e of [
      'task_not_found',
      'not_live',
      'identity_mismatch',
      'no_target',
      'unsupported',
      'command_failed',
      'disabled',
    ]) {
      expect(refusalHelp(e).length).toBeGreaterThan(0);
    }
  });
});

/**
 * The outcome must OUTLIVE the row — a regression guard for a defect measured live, not
 * imagined (2026-08-09, real Tauri webview, real server).
 *
 * The kill is exactly the event that removes its own row: the route invalidates
 * `taskManager.inventory`, the task stops being running, and the default view is
 * running-only. Driving a genuine refusal end-to-end (`not_live`, HTTP 200, verbatim
 * detail) produced NEITHER `task-kill-refused-…` NOR `task-kill-done-…` anywhere in the
 * DOM, because the row carrying them had already unmounted. A destructive control whose
 * ANSWER is unreadable is the failure P-025 exists to prevent — the reader cannot tell a
 * refusal from a success, and the natural response to that ambiguity is to click again.
 *
 * `rowsPresent` below models the ONE thing that matters: the row leaving the pane's row
 * set. When it is gone the control unmounts, exactly as it does in the live pane.
 */
describe('kill outcome survives its row unmounting', () => {
  function Harness({ rows, r }: { rows: { taskId: string }[]; r: KillableRow }): ReactElement {
    const { outcomeContext, notice } = useKillOutcomeHoist(rows);
    return (
      <div>
        {notice}
        <KillOutcomeProvider value={outcomeContext}>
          {rows.some((x) => x.taskId === r.taskId) ? <KillTaskControl row={r} /> : null}
        </KillOutcomeProvider>
      </div>
    );
  }

  /** Arm and fire, leaving the outcome reported. */
  async function killIt(): Promise<void> {
    fireEvent.click(screen.getByTestId('task-kill-t1'));
    fireEvent.click(await screen.findByTestId('task-kill-yes-t1'));
  }

  it('shows NOTHING at pane level while the row is still on screen (the chip is the better placement)', async () => {
    H.reply = { ok: true, detail: 'scope pc-t1.scope signalled SIGTERM' };
    render(<Harness rows={[{ taskId: 't1' }]} r={row()} />);
    await killIt();

    await screen.findByTestId('task-kill-done-t1');
    // Two banners saying the same thing would read as two separate events.
    expect(screen.queryByTestId('task-kill-notice-t1')).toBeNull();
  });

  it('surfaces a SUCCESS at pane level once the killed row has left the table', async () => {
    H.reply = { ok: true, detail: 'scope pc-t1.scope signalled SIGTERM' };
    const { rerender } = render(<Harness rows={[{ taskId: 't1' }]} r={row()} />);
    await killIt();
    await screen.findByTestId('task-kill-done-t1');

    // The invalidation lands: the task is no longer running, so it drops out of the view.
    rerender(<Harness rows={[]} r={row()} />);

    const notice = await screen.findByTestId('task-kill-notice-t1');
    expect(notice.textContent).toContain('t1');
    expect(notice.textContent).toContain('signalled');
    // The server's own words survive the row.
    expect(notice.textContent).toContain('scope pc-t1.scope signalled SIGTERM');
    expect(screen.queryByTestId('task-kill-done-t1')).toBeNull();
  });

  it('surfaces a REFUSAL verbatim at pane level once the row is gone, as role=alert', async () => {
    // The exact refusal the live probe produced.
    H.reply = {
      ok: false,
      error: 'not_live',
      detail: 'state is exited — a residue or terminal row is never ours to signal',
    };
    const { rerender } = render(<Harness rows={[{ taskId: 't1' }]} r={row()} />);
    await killIt();
    await screen.findByTestId('task-kill-refused-t1');

    rerender(<Harness rows={[]} r={row()} />);

    const notice = await screen.findByTestId('task-kill-notice-t1');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('not_live');
    // VERBATIM — the server's sentence, not a paraphrase.
    expect(notice.textContent).toContain('state is exited — a residue or terminal row is never ours to signal');
    // And the sentence that says a refusal is the rail working, not a fault.
    expect(notice.textContent).toContain(refusalHelp('not_live'));
  });

  it('is dismissable, and stays dismissed', async () => {
    H.reply = { ok: false, error: 'identity_mismatch', detail: 'pid 42 is gone' };
    const { rerender } = render(<Harness rows={[{ taskId: 't1' }]} r={row()} />);
    await killIt();
    rerender(<Harness rows={[]} r={row()} />);

    fireEvent.click(await screen.findByTestId('task-kill-notice-dismiss-t1'));
    expect(screen.queryByTestId('task-kill-notice-t1')).toBeNull();
  });

  it('reports the taskId, which is the only handle left once the row is gone', async () => {
    H.reply = { ok: true, detail: 'scope pc-other.scope signalled SIGTERM' };
    const other = row({ taskId: 'other-task' });
    const { rerender } = render(<Harness rows={[{ taskId: 'other-task' }]} r={other} />);
    fireEvent.click(screen.getByTestId('task-kill-other-task'));
    fireEvent.click(await screen.findByTestId('task-kill-yes-other-task'));
    await screen.findByTestId('task-kill-done-other-task');

    rerender(<Harness rows={[]} r={other} />);
    const notice = await screen.findByTestId('task-kill-notice-other-task');
    expect(notice.textContent).toContain('other-task');
  });
});
