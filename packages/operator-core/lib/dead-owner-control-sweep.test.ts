import { describe, expect, it, vi } from 'vitest';
import { sweepDeadOwnerControlState } from './dead-owner-control-sweep';

function makeSql(row: {
  owners: string[] | null;
  loops_terminated: string | number;
  holds_lifted: string | number;
  lifted_items?: Array<{ workspace_id: string; feature_id: string; former_holder: string }>;
}) {
  const calls: unknown[][] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push([strings, ...values]);
    return [{ ...row, lifted_items: row.lifted_items ?? [] }];
  });
  const unsafe = vi.fn((value: string, _params?: unknown[]) => {
    // `sql.unsafe(text)` (no params, used for raw fragments) returns the text unchanged so it
    // can be interpolated back into a tagged template; `sql.unsafe(text, params)` (the audit
    // INSERT) is a real async write — resolve like the driver would.
    if (_params === undefined) return value;
    return Promise.resolve([]);
  });
  Object.assign(sql, { unsafe });
  return sql as typeof sql & { unsafe: typeof unsafe };
}

describe('sweepDeadOwnerControlState', () => {
  it('returns the entire owner/loop/hold batch from one SQL statement', async () => {
    const sql = makeSql({ owners: ['su-dead'], loops_terminated: '3', holds_lifted: '5' });
    const result = await sweepDeadOwnerControlState(sql as never, { ownerGraceMs: 1, holdOpenGraceMs: 1 });
    expect(result).toEqual({ owners: ['su-dead'], loopsTerminated: 3, holdsLifted: 5 });
    // Two calls build the reusable liveness SQL fragments; the final tagged
    // call is the one atomic database statement containing both UPDATE CTEs.
    const fragments = (sql as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as TemplateStringsArray;
    expect(fragments.join('')).toContain('ended_loop AS');
    expect(fragments.join('')).toContain('lifted_hold AS');
  });

  it('WI-42279: an armed loop cannot prove its own owner live to the loop reaper', async () => {
    const sql = makeSql({ owners: [], loops_terminated: 0, holds_lifted: 0 });

    await sweepDeadOwnerControlState(sql as never, { ownerGraceMs: 1, holdOpenGraceMs: 1 });

    const renderedCalls = (sql as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(''),
    );
    const sessionLiveness = renderedCalls.find(
      (text) =>
        text.includes('harness_shared.coord_presence') && text.includes('harness_shared.spawned_agents'),
    );
    expect(sessionLiveness).toBeDefined();
    expect(sessionLiveness).not.toContain('FROM harness_shared.routines');

    const sweepStatement = renderedCalls.at(-1)!;
    expect(sweepStatement).toContain('FROM harness_shared.routines r');
  });

  it('WI-6774: the lifted_hold clear excludes policy-tier holds (SQL predicate present)', async () => {
    const sql = makeSql({ owners: [], loops_terminated: 0, holds_lifted: 0 });
    await sweepDeadOwnerControlState(sql as never, { ownerGraceMs: 1, holdOpenGraceMs: 1 });
    const fragments = (sql as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as TemplateStringsArray;
    const text = fragments.join('${}');
    expect(text).toContain("~* ANY(");
    expect(text).toContain('held_open_reason');
  });

  it('WI-6774: a lifted hold writes a structural audit_log row via recordBulkHoldClearAudit', async () => {
    const sql = makeSql({
      owners: ['su-dead'],
      loops_terminated: 0,
      holds_lifted: 1,
      lifted_items: [{ workspace_id: 'ws1', feature_id: 'WI-1', former_holder: 'su-dead' }],
    });
    await sweepDeadOwnerControlState(sql as never, { ownerGraceMs: 1, holdOpenGraceMs: 1 });
    // The audit write is `recordBulkHoldClearAudit`'s fire-and-forget INSERT via `sql.unsafe` —
    // give the microtask queue a turn before asserting.
    await new Promise((r) => setTimeout(r, 0));
    const insertCalls = sql.unsafe.mock.calls.filter((c) => c[1] !== undefined);
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0][0]).toContain('INSERT INTO harness_shared.audit_log');
    const params = insertCalls[0][1] as unknown[];
    expect(params[3]).toBe('work_items:claim_hold:clear'); // action
    expect(params[4]).toBe('WI-1'); // subject
    expect(params[6]).toBe('ws1'); // workspace_id
    expect(JSON.parse(params[5] as string)).toMatchObject({
      sweep: 'sweepDeadOwnerControlState',
      formerHolder: 'su-dead',
    });
  });
});
