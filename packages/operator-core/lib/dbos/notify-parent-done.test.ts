/**
 * notify-parent-done — the afterDone builtin that posts a `Completion` to the
 * parent harness when a spawned child's queue DRAINS (promote-spawn-child P-004).
 *
 * Covers the full branch matrix through the DI seam — no PG and no `vi.mock`
 * (so it cannot leak a module mock into a sibling test the way the fleet just
 * flagged for the locks suite). Each case injects a fake org-PG tagged-template
 * + a fake `sendMessage` (retire-work-item-mail-surface-2026-07-26 P-006: this
 * used to inject a fake `dispatchAction({op:'send_message'})`; that verb was
 * retired, the builtin now rides `sendMessage` — the same primitive
 * `coord:send` uses — directly).
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
  sendImpl?: (...args: unknown[]) => Promise<unknown>,
) {
  const sql = makeSql(sqlReturns);
  const send = vi.fn(sendImpl ?? (() => Promise.resolve({ msg_id: 'm-1' })));
  const di: NotifyDeps = {
    sql: sql as unknown as NotifyDeps['sql'],
    send: send as unknown as NotifyDeps['send'],
  };
  return { sql, send, di };
}

const BASE = { harnessSlug: 'child-h', workspaceId: 'ws-1', featureId: 'F-9' };

describe('notifyParentOnDone — afterDone parent-completion builtin', () => {
  it('no parent → reports no_parent and never sends', async () => {
    const { send, di } = makeDeps([[]]); // parent lookup returns no rows
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: false, reason: 'no_parent' });
    expect(send).not.toHaveBeenCalled();
  });

  it('queue not drained → reports queue_not_drained with the remaining count, no send', async () => {
    const { send, di } = makeDeps([[{ parent_slug: 'parent-h' }], [{ n: 3 }]]);
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: false, parent: 'parent-h', reason: 'queue_not_drained', remaining: 3 });
    expect(send).not.toHaveBeenCalled();
  });

  it('drained → sends a Completion to the parent (child is the sender identity) and reports notified', async () => {
    const { sql, send, di } = makeDeps([[{ parent_slug: 'parent-h' }], [{ n: 0 }]]);
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: true, parent: 'parent-h' });
    expect(send).toHaveBeenCalledTimes(1);
    const [identity, options] = send.mock.calls[0] as [
      { ownerId: string },
      { to: string[]; summary: string; body: string; harnessSlug: string },
    ];
    expect(identity.ownerId).toBe('harness-afterdone:child-h'); // the child is named in the sender identity
    expect(options).toMatchObject({ to: ['parent-h'], harnessSlug: 'child-h' });
    expect(options.summary).toContain('child-h');
    expect(options.body).toContain('F-9');
    // the drain count EXCLUDES the triggering feature and is workspace-scoped:
    // call[1] values are [workspaceId, harnessSlug, featureId].
    expect(sql.calls[1]).toEqual(['ws-1', 'child-h', 'F-9']);
  });

  it('send throws → swallowed, reports send_failed (best-effort, never throws)', async () => {
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
    const { send, di } = makeDeps([new Error('db down')]);
    const r = await notifyParentOnDone({ ...BASE, deps: di });
    expect(r).toEqual({ notified: false, reason: 'lookup_failed' });
    expect(send).not.toHaveBeenCalled();
  });
});
