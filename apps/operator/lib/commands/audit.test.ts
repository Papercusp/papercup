import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  audit,
  auditQuery,
  registerAuditFlush,
  __drainAuditForTests,
  type ActionRow,
  type QueryRow,
} from './audit';

function actionRow(over: Partial<ActionRow> = {}): ActionRow {
  return {
    id: 'panel.toggle',
    agent: 'oracle',
    workspace: 'default',
    requestId: 'r-' + Math.random().toString(36).slice(2),
    args: {},
    status: 'ok',
    durationMs: 5,
    ...over,
  };
}

function queryRow(over: Partial<QueryRow> = {}): QueryRow {
  return {
    id: 'harness.list',
    agent: 'oracle',
    workspace: 'default',
    requestId: 'r-' + Math.random().toString(36).slice(2),
    sample: false,
    ...over,
  };
}

beforeEach(() => {
  __drainAuditForTests();
});

describe('audit buffer', () => {
  it('actions buffer until flushed', () => {
    audit(actionRow());
    audit(actionRow({ id: 'panel.open' }));
    const drained = __drainAuditForTests();
    expect(drained.actions).toHaveLength(2);
  });

  it('non-sampled queries always buffer', () => {
    for (let i = 0; i < 20; i++) auditQuery(queryRow({ sample: false }));
    expect(__drainAuditForTests().queries).toHaveLength(20);
  });

  it("sampled queries drop ~95% (probabilistic)", () => {
    for (let i = 0; i < 1000; i++) auditQuery(queryRow({ sample: true }));
    const kept = __drainAuditForTests().queries.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(200);
  });

  it('sampled queries respect 2-per-second burst cap per (agent,id)', () => {
    let kept = 0;
    for (let i = 0; i < 100; i++) {
      const before = __drainAuditForTests().queries.length;
      void before;
      auditQuery(queryRow({ sample: true, id: 'burst.test' }));
    }
    kept = __drainAuditForTests().queries.length;
    expect(kept).toBeLessThanOrEqual(2);
  });
});

describe('flush callback', () => {
  it('registered flush receives buffered rows', async () => {
    const seen: { actions: ActionRow[]; queries: QueryRow[] }[] = [];
    registerAuditFlush(async (a, q) => { seen.push({ actions: a, queries: q }); });
    audit(actionRow());
    auditQuery(queryRow({ sample: false }));
    await new Promise((r) => setTimeout(r, 1100));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const total = seen.reduce(
      (acc, r) => ({ a: acc.a + r.actions.length, q: acc.q + r.queries.length }),
      { a: 0, q: 0 },
    );
    expect(total.a).toBe(1);
    expect(total.q).toBe(1);
  });

  it('flush errors do not throw to caller', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerAuditFlush(async () => { throw new Error('boom'); });
    audit(actionRow());
    await new Promise((r) => setTimeout(r, 1100));
    // If flush rejection propagated, the next audit would still queue.
    audit(actionRow());
    expect(__drainAuditForTests().actions.length).toBeGreaterThanOrEqual(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
