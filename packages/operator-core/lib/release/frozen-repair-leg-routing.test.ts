import { describe, expect, it, vi } from 'vitest';
import { actionableConditionFor } from '../coord/actionable-conditions';
import { resolveConditionHarness } from '../coord/condition-bridge';
import {
  MAX_ROUTED_LEGS,
  frozenRepairLegConditionKey,
  planFrozenRepairLegRouting,
} from './frozen-repair-agent-routing';
import { routeFrozenRepairLegs, type FrozenRepairLegRoutingDeps } from './frozen-repair-leg-routing';

const CAND = 'c'.repeat(40);
const HEAD = 'h'.repeat(40);
const queue = (failingTests: string[]) => ({ candidate: CAND, repairHead: HEAD, failingTests });
const key = (entry: string, pipeline = 'papercusp') => frozenRepairLegConditionKey(pipeline, entry, CAND, HEAD);

describe('planFrozenRepairLegRouting (P-013 / D-029)', () => {
  it('preserves full path, case and evidence bytes while keeping distinct complete identities', () => {
    const entry = ' packages/a long/quoted:case.test.ts ';
    const record = { id: entry, kind: 'test-file' as const, recipe: 'native test', admittedRound: 1,
      measuredHead: HEAD, cases: ['decisive → ' + 'x'.repeat(1601)] };
    const output = ' \nfull recorded output\n ';
    const plan = planFrozenRepairLegRouting({ pipeline: 'papercusp',
      queue: { ...queue([entry, entry.trim()]), signature: [record] }, openLegKeys: [],
      failureTails: new Map([[entry, output]]) });
    expect(plan.routed).toEqual([entry, entry.trim()]);
    expect(new Set(plan.open.map((o) => o.conditionKey)).size).toBe(2);
    expect(plan.open[0]!.failure).toEqual({ pipeline: 'papercusp', candidate: CAND, repairHead: HEAD,
      entry, signature: record, output });
    const changedCase = planFrozenRepairLegRouting({ pipeline: 'papercusp',
      queue: { ...queue([entry]), signature: [{ ...record, cases: ['another case'] }] }, openLegKeys: [] });
    expect(changedCase.open[0]!.conditionKey).not.toBe(plan.open[0]!.conditionKey);
    const changedHead = planFrozenRepairLegRouting({ pipeline: 'papercusp',
      queue: { ...queue([entry]), repairHead: 'new head', signature: [record] }, openLegKeys: [] });
    expect(changedHead.open[0]!.conditionKey).not.toBe(plan.open[0]!.conditionKey);
    const changedCandidate = planFrozenRepairLegRouting({ pipeline: 'papercusp',
      queue: { ...queue([entry]), candidate: 'another candidate', signature: [record] }, openLegKeys: [] });
    expect(changedCandidate.open[0]!.conditionKey).not.toBe(plan.open[0]!.conditionKey);
  });

  it('rejects invalid or conflicting semantic records intact', () => {
    expect(() => planFrozenRepairLegRouting({ pipeline: 'papercusp', queue: queue(['']), openLegKeys: [] }))
      .toThrow('Invalid frozen failure identity');
    const record = { id: 'a/b.test.ts', kind: 'test-file' as const, recipe: 'test', admittedRound: 1,
      measuredHead: HEAD, cases: ['first'] };
    expect(() => planFrozenRepairLegRouting({ pipeline: 'papercusp',
      queue: { ...queue([record.id]), signature: [record, { ...record, cases: ['second'] }] },
      openLegKeys: [] })).toThrow('Conflicting frozen failure records');
  });

  it('opens one claimable item per failing leg, keyed so the bridge files it under the pipeline', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc']),
      openLegKeys: [],
    });
    expect(plan.open.map((o) => o.conditionKey)).toEqual([key('packages/a/x.test.ts'), key('lint:tsc')]);
    expect(plan.resolve).toEqual([]);
    for (const o of plan.open) {
      expect(actionableConditionFor(o.conditionKey)?.severity).toBe('major');
      expect(resolveConditionHarness(o.conditionKey, null)).toBe('papercusp');
    }
  });

  it('never opens a second item for a leg that is already open', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc']),
      openLegKeys: [key('packages/a/x.test.ts')],
    });
    expect(plan.open.map((o) => o.entry)).toEqual(['lint:tsc']);
  });

  it('resolves an open leg once it leaves the failing set, and leaves other pipelines alone', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['lint:tsc']),
      openLegKeys: [key('packages/a/x.test.ts'), key('lint:tsc'), key('lint:tsc', 'portal')],
    });
    expect(plan.resolve).toEqual([key('packages/a/x.test.ts')]);
    expect(plan.open).toEqual([]);
  });

  it('a leg already passing clean CI at the repair head is not opened, and its open item resolves (EI-27221104393614066)', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc', 'packages/b/y.test.ts']),
      openLegKeys: [key('packages/a/x.test.ts')],
      passedAtRepairHead: new Set(['packages/a/x.test.ts', 'packages/b/y.test.ts']),
    });
    expect(plan.open.map((o) => o.entry)).toEqual(['lint:tsc']);
    expect(plan.resolve).toEqual([key('packages/a/x.test.ts')]);
  });

  it('CONTROL: without pass-at-repair-head evidence the same queue routes every leg', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc', 'packages/b/y.test.ts']),
      openLegKeys: [key('packages/a/x.test.ts')],
    });
    expect(plan.open.map((o) => o.entry)).toEqual(['lint:tsc', 'packages/b/y.test.ts']);
    expect(plan.resolve).toEqual([]);
  });

  it('a gone queue (null) resolves every open leg of the pipeline', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: null,
      openLegKeys: [key('a/b.test.ts'), key('lint:tsc')],
    });
    expect(plan.resolve).toEqual([key('a/b.test.ts'), key('lint:tsc')].sort());
    expect(plan.open).toEqual([]);
  });

  it.each([MAX_ROUTED_LEGS - 1, MAX_ROUTED_LEGS, MAX_ROUTED_LEGS + 1, 101, 137])('routes all %i failures without a window', (n) => {
    const entries = Array.from({ length: n }, (_, i) => `pkg/t${i}.test.ts`);
    const first = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue([...entries, entries[0]!]),
      openLegKeys: [],
    });
    expect(first.open.map((o) => o.entry)).toEqual(entries);
    expect(first.routed).toEqual(entries);
    const second = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(entries.slice(1)),
      openLegKeys: first.open.map((o) => o.conditionKey),
    });
    expect(second.resolve).toEqual([key(entries[0]!)]);
    expect(second.open).toEqual([]);
  });

  it('the body carries the leg, both shas, the failure tail and a path-exact admit call', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc']),
      openLegKeys: [],
      failureTails: new Map([['packages/a/x.test.ts', 'AssertionError: expected 2 to be 3']]),
    });
    const [test, lint] = plan.open;
    expect(test!.body).toContain(CAND);
    expect(test!.body).toContain(HEAD);
    expect(test!.body).toContain('AssertionError: expected 2 to be 3');
    expect(test!.body).toContain("release:repair-queue { op: 'admit', paths: ['packages/a/x.test.ts'] }");
    expect(test!.summary).toContain('live gate owner');
    // A leg name is not a path, so its admit call names the files the fixer changed.
    expect(lint!.body).not.toContain("paths: ['lint:tsc']");
    expect(lint!.body).toContain('none recorded for this leg');
  });

  it('keeps current-run repair with its gate owner while allowing independent source work (EI-27206037186017447)', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc']),
      openLegKeys: [],
    });
    for (const leg of plan.open) {
      expect(leg.summary).not.toContain('no gate ownership needed');
      expect(leg.body).toContain("state:read { cell: 'gate.greenCheckpoint.ownership' }");
      expect(leg.body).toContain('held by another live agent');
      expect(leg.body).toContain('send useful evidence once');
      expect(leg.body).toContain('stop current-run operations');
      expect(leg.body).toContain('If you hold the gate');
      expect(leg.body).toContain('If the gate is genuinely unheld');
      expect(leg.body).toContain('Independently registered source work');
      expect(leg.body).toContain('its own work-item and file locks');
      expect(leg.body).toContain('GATE OWNER ADMISSION');
      expect(leg.body).not.toContain('Any agent may take it');
      expect(leg.body).not.toContain('Admission needs no gate ownership');
    }
  });
});

describe('routeFrozenRepairLegs', () => {
  const fakeDeps = (open: string[], over: Partial<FrozenRepairLegRoutingDeps> = {}) => {
    const deps = {
      readOpenConditionKeys: vi.fn(async (prefix: string) => open.filter((k) => k.startsWith(prefix))),
      readFailureTails: vi.fn(async () => new Map<string, string>()),
      broadcastOpen: vi.fn(async () => true),
      broadcastResolved: vi.fn(async () => true),
      ...over,
    };
    return deps;
  };

  it('a steady-state tick reads no tails and broadcasts nothing', async () => {
    const deps = fakeDeps([key('lint:tsc')]);
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['lint:tsc']) }, deps);
    expect(out).toMatchObject({ opened: [], resolved: [] });
    expect(deps.readFailureTails).not.toHaveBeenCalled();
    expect(deps.broadcastOpen).not.toHaveBeenCalled();
    expect(deps.broadcastResolved).not.toHaveBeenCalled();
  });

  it('opens new legs with their tails and resolves departed legs in ONE message', async () => {
    const deps = fakeDeps([key('old/gone.test.ts')], {
      readFailureTails: vi.fn(async () => new Map([['new/x.test.ts', 'boom']])),
    });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['new/x.test.ts']) }, deps);
    expect(deps.readFailureTails).toHaveBeenCalledWith({
      candidate: CAND,
      repairHead: HEAD,
      entries: ['new/x.test.ts'],
    });
    expect(deps.broadcastOpen).toHaveBeenCalledTimes(1);
    // `...over` widens each field to the deps signature, so read the calls through vi.mocked.
    const opened = vi.mocked(deps.broadcastOpen).mock.calls[0]![0];
    expect(opened).toMatchObject({ conditionKey: key('new/x.test.ts') });
    expect(opened.body).toContain('boom');
    expect(deps.broadcastResolved).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.broadcastResolved).mock.calls[0]![0]).toMatchObject({
      conditionKeys: [key('old/gone.test.ts')],
    });
    expect(out).toMatchObject({ opened: [key('new/x.test.ts')], resolved: [key('old/gone.test.ts')] });
  });

  it('a failing tail read still opens the item, without the tail', async () => {
    const deps = fakeDeps([], {
      readFailureTails: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['a/b.test.ts']) }, deps);
    expect(out.opened).toEqual([key('a/b.test.ts')]);
  });

  it('a new leg already passing at the repair head mints nothing (EI-27221104393614066)', async () => {
    const readPassedAtRepairHead = vi.fn(async () => new Set(['a/b.test.ts']));
    const deps = fakeDeps([], { readPassedAtRepairHead });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['a/b.test.ts']) }, deps);
    expect(readPassedAtRepairHead).toHaveBeenCalledWith({ repairHead: HEAD, entries: ['a/b.test.ts'] });
    expect(deps.broadcastOpen).not.toHaveBeenCalled();
    expect(out.opened).toEqual([]);
  });

  it('a throwing pass-at-repair-head read still opens the item', async () => {
    const deps = fakeDeps([], {
      readPassedAtRepairHead: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['a/b.test.ts']) }, deps);
    expect(out.opened).toEqual([key('a/b.test.ts')]);
  });

  it('a steady-state tick does not read pass-at-repair-head evidence', async () => {
    const readPassedAtRepairHead = vi.fn(async () => new Set<string>());
    const deps = fakeDeps([key('lint:tsc')], { readPassedAtRepairHead });
    await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['lint:tsc']) }, deps);
    expect(readPassedAtRepairHead).not.toHaveBeenCalled();
  });

  it('a lost broadcast is not reported as opened, so the next tick retries it', async () => {
    const deps = fakeDeps([], { broadcastOpen: vi.fn(async () => false) });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['a/b.test.ts']) }, deps);
    expect(out.opened).toEqual([]);
    expect(out.plan.open).toHaveLength(1);
  });

  // WI-6554700010018714: a lint leg has no test_runs row, so its item said "none recorded for
  // this leg" while the gate's verdict line carried the tail — and the fixer reproduced it
  // outside the gate env, where it passed. A caller-held tail must reach the item.
  it('a lint leg routed with a caller-held tail carries it, and only the other entries hit the ledger', async () => {
    const tail =
      'lint:condition-rail: exit 1 — AdmissionPersistenceError: password authentication failed | sqlstate=28P01';
    const deps = fakeDeps([], {
      readFailureTails: vi.fn(async () => new Map([['a/b.test.ts', 'boom']])),
    });
    const out = await routeFrozenRepairLegs(
      {
        pipeline: 'papercusp',
        queue: queue(['lint:condition-rail', 'a/b.test.ts']),
        failureTails: new Map([['lint:condition-rail', tail]]),
      },
      deps,
    );
    expect(out.opened).toEqual([key('lint:condition-rail'), key('a/b.test.ts')]);
    expect(deps.readFailureTails).toHaveBeenCalledWith({
      candidate: CAND,
      repairHead: HEAD,
      entries: ['a/b.test.ts'],
    });
    const bodies = new Map(
      vi.mocked(deps.broadcastOpen).mock.calls.map(([ev]) => [ev.conditionKey, ev.body] as const),
    );
    expect(bodies.get(key('lint:condition-rail'))).toContain('sqlstate=28P01');
    expect(bodies.get(key('lint:condition-rail'))).not.toContain('none recorded for this leg');
    expect(bodies.get(key('a/b.test.ts'))).toContain('boom');
  });

  it('a caller-held tail for every new entry skips the ledger read', async () => {
    const deps = fakeDeps([]);
    await routeFrozenRepairLegs(
      { pipeline: 'papercusp', queue: queue(['lint:tsc']), failureTails: new Map([['lint:tsc', 'TS2322']]) },
      deps,
    );
    expect(deps.readFailureTails).not.toHaveBeenCalled();
    expect(vi.mocked(deps.broadcastOpen).mock.calls[0]![0].body).toContain('TS2322');
  });

  it('retains blank recorded bytes when the ledger has no replacement evidence', async () => {
    const deps = fakeDeps([]);
    await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['lint:tsc']),
      failureTails: new Map([['lint:tsc', '   ']]) }, deps);
    expect(vi.mocked(deps.broadcastOpen).mock.calls[0]![0].failure.output).toBe('   ');
    expect(deps.readFailureTails).toHaveBeenCalled();
  });

  it('a blank caller-held tail falls back to the ledger', async () => {
    const deps = fakeDeps([], {
      readFailureTails: vi.fn(async () => new Map([['lint:tsc', 'from-ledger']])),
    });
    await routeFrozenRepairLegs(
      { pipeline: 'papercusp', queue: queue(['lint:tsc']), failureTails: new Map([['lint:tsc', '   ']]) },
      deps,
    );
    expect(deps.readFailureTails).toHaveBeenCalledWith({ candidate: CAND, repairHead: HEAD, entries: ['lint:tsc'] });
    expect(vi.mocked(deps.broadcastOpen).mock.calls[0]![0].body).toContain('from-ledger');
  });
});
