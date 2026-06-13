/**
 * notify-parent-done — the afterDone builtin that posts a `Completion` to the
 * parent harness when a spawned child's queue DRAINS (promote-spawn-child P-004).
 *
 * Covers the full branch matrix through the DI seam — no PG and no `vi.mock`
 * (so it cannot leak a module mock into a sibling test the way the fleet just
 * flagged for the locks suite). Each case injects a fake org-PG tagged-template
 * + a fake action dispatcher.
 */
import { describe, it, expect, vi } from 'vitest';
import { notifyParentOnDone } from './notify-parent-done';

type NotifyOpts = Parameters<typeof notifyParentOnDone>[0];
type NotifyDeps = NonNullable<NotifyOpts['deps']>;

type SqlReturn = unknown[] | Error;

/**
 * A fake org-PG tagged-template: returns the canned rows for each call in
 * order, recording the interpolated values per call (the TemplateStringsArray
 * is dropped). An `Error` entry rejects, to exercise the lookup_failed path.
 */
function makeSql(returns: SqlReturn[]) {
  let i = 0;
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args.slice(1));
    const r = returns[i++] ?? [];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return Object.assign(fn, { calls });
}

function makeDeps(
  sqlReturns: SqlReturn[],
  dispatchImpl?: (...args: unknown[]) => Promise<unknown>,
) {
  const sql = makeSql(sqlReturns);
  const dispatch = vi.fn(dispatchImpl ?? (() => Promise.resolve({ ok: true })));
  const di: NotifyDeps = {
    sql: sql as unknown as NotifyDeps['sql'],
    dispatch: dispatch as unknown as NotifyDeps['dispatch'],
  };
  return { sql, dispatch, di };
}

const BASE = { harnessSlug: 'child-h', workspaceId: 'ws-1', featureId: 'F-9' };

describe('notifyParentOnDone — afterDone parent-completion builtin', () => {
  it('no parent → reports no_parent and never sends', async () => {
    const { dispatch, di } = makeDeps([[]]); // parent lookup returns no rows
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: false, reason: 'no_parent' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('queue not drained → reports queue_not_drained with the remaining count, no send', async () => {
    const { dispatch, di } = makeDeps([[{ parent_slug: 'parent-h' }], [{ n: 3 }]]);
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: false, parent: 'parent-h', reason: 'queue_not_drained', remaining: 3 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('drained → posts a Completion to the parent (child is the caller) and reports notified', async () => {
    const { sql, dispatch, di } = makeDeps([[{ parent_slug: 'parent-h' }], [{ n: 0 }]]);
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: true, parent: 'parent-h' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [callerSlug, action] = dispatch.mock.calls[0] as [
      string,
      { op: string; to: string[]; kind: string; body: string },
    ];
    expect(callerSlug).toBe('child-h'); // the child is the bearer/caller
    expect(action).toMatchObject({ op: 'send_message', to: ['parent-h'], kind: 'Completion' });
    expect(action.body).toContain('F-9');
    // the drain count EXCLUDES the triggering feature and is workspace-scoped:
    // call[1] values are [workspaceId, harnessSlug, featureId].
    expect(sql.calls[1]).toEqual(['ws-1', 'child-h', 'F-9']);
  });

  it('dispatch returns not-ok → reports send_failed (keeps the parent)', async () => {
    const { di } = makeDeps(
      [[{ parent_slug: 'parent-h' }], [{ n: 0 }]],
      () => Promise.resolve({ ok: false, error: 'rate-limited' }),
    );
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: false, parent: 'parent-h', reason: 'send_failed' });
  });

  it('dispatch throws → swallowed, reports send_failed (best-effort, never throws)', async () => {
    const { di } = makeDeps(
      [[{ parent_slug: 'parent-h' }], [{ n: 0 }]],
      () => Promise.reject(new Error('boom')),
    );
    await expect(notifyParentOnDone({ ...BASE, deps: di })).resolves.toEqual({
      notified: false,
      parent: 'parent-h',
      reason: 'send_failed',
    });
  });

  it('PG lookup throws → swallowed, reports lookup_failed and never sends', async () => {
    const { dispatch, di } = makeDeps([new Error('db down')]);
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: false, reason: 'lookup_failed' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
