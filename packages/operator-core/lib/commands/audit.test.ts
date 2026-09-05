import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  audit,
  auditQuery,
  registerAuditFlush,
  __drainAuditForTests,
  __burstWindowSizeForTests,
  BURST_PRUNE_AT,
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

describe('burst-window retention (WI-2145588)', () => {
  it('reclaims entries for agents that have gone quiet', () => {
    // Force every sampled row past the 1-in-20 gate so burstAllow always runs.
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0);
    // Anchor to real time: earlier tests in this module already put a couple of
    // keys in the map, and a clock that started below them would make those
    // entries look permanently fresh.
    let clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      // Churn: each agent id is seen once and never again — sessions die and
      // respawn with fresh ids, which is what made this key set grow forever.
      const churned = BURST_PRUNE_AT * 2;
      for (let i = 0; i < churned; i++) {
        auditQuery(queryRow({ agent: `agent-${i}` as QueryRow['agent'], sample: true }));
      }
      // >= rather than ==: a couple of keys survive from earlier tests here.
      expect(__burstWindowSizeForTests()).toBeGreaterThanOrEqual(churned);

      // Every one of those agents is now long gone.
      clock += 60_000;
      auditQuery(queryRow({ agent: 'fresh-agent' as QueryRow['agent'], sample: true }));

      // Pre-fix nothing was ever deleted, so this was churned + 1 and grew
      // without bound for the process lifetime.
      expect(__burstWindowSizeForTests()).toBeLessThanOrEqual(2);
    } finally {
      now.mockRestore();
      rand.mockRestore();
      __drainAuditForTests();
    }
  });

  it('still rate-limits a single hot key to 2 per second', () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      __drainAuditForTests();
      for (let i = 0; i < 10; i++) auditQuery(queryRow({ agent: 'hot-agent', sample: true }));
      // The burst cap admits 2; the rest are dropped before reaching the buffer.
      expect(__drainAuditForTests().queries).toHaveLength(2);
    } finally {
      rand.mockRestore();
      __drainAuditForTests();
    }
  });
});
