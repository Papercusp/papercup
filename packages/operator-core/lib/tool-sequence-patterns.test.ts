import { describe, it, expect } from 'vitest';
import {
  collapseSpawnsToDecisions,
  sequenceId,
  DEFAULT_DISPATCHER_TOOLS,
} from './tool-sequence-patterns';
import { minePatternsFromEvents } from '@papercusp/sequence-patterns';

type Row = { agent: string; tool_name: string; spawn_id: string; invoked_at: string };
const row = (agent: string, tool: string, spawn: string, iso: string): Row => ({
  agent,
  tool_name: tool,
  spawn_id: spawn,
  invoked_at: iso,
});

describe('collapseSpawnsToDecisions — one spawn is one agent decision', () => {
  it('keeps a lone call as-is', () => {
    const { events, collapsed } = collapseSpawnsToDecisions([
      row('a1', 'work_items:get', 'sp-1', '2026-08-09T00:00:00.000Z'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.symbol).toBe('work_items:get');
    expect(events[0]!.cohort).toBe('a1');
    expect(collapsed).toBe(0);
  });

  it('collapses a code:run and its script-internal calls to the code:run', () => {
    // Shape measured live: a code:run script calls three tools, all under one
    // spawn, and the wrapper row is written LAST. The agent made ONE decision —
    // to run the script — so the script's internals are implementation.
    const { events, collapsed } = collapseSpawnsToDecisions([
      row('a1', 'events:cancel', 'sp-1', '2026-08-09T00:00:00.258Z'),
      row('a1', 'dev:pg_query', 'sp-1', '2026-08-09T00:00:00.291Z'),
      row('a1', 'coord:orient', 'sp-1', '2026-08-09T00:00:30.134Z'),
      row('a1', 'code:run', 'sp-1', '2026-08-09T00:00:30.136Z'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.symbol).toBe('code:run');
    expect(collapsed).toBe(3);
  });

  it('UNWRAPS a pure dispatcher to the tool it dispatched', () => {
    // tools:invoke is dispatch, not intent — the agent meant plans:add-decision.
    const { events } = collapseSpawnsToDecisions([
      row('a1', 'plans:add-decision', 'sp-1', '2026-08-09T00:00:01.749Z'),
      row('a1', 'tools:invoke', 'sp-1', '2026-08-09T00:00:01.757Z'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.symbol).toBe('plans:add-decision');
  });

  it('does not unwrap code:run — running a script IS the decision', () => {
    expect(DEFAULT_DISPATCHER_TOOLS).not.toContain('code:run');
  });

  it('unwraps through STACKED dispatchers rather than stopping at the first', () => {
    const { events } = collapseSpawnsToDecisions([
      row('a1', 'testing:run', 'sp-1', '2026-08-09T00:00:01.700Z'),
      row('a1', 'tools:invoke', 'sp-1', '2026-08-09T00:00:01.750Z'),
      row('a1', 'tools:invoke', 'sp-1', '2026-08-09T00:00:01.760Z'),
    ]);
    expect(events[0]!.symbol).toBe('testing:run');
  });

  it('never walks past the innermost row even if every row is a dispatcher', () => {
    const { events } = collapseSpawnsToDecisions([
      row('a1', 'tools:invoke', 'sp-1', '2026-08-09T00:00:01.750Z'),
      row('a1', 'tools:invoke', 'sp-1', '2026-08-09T00:00:01.760Z'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.symbol).toBe('tools:invoke');
  });

  it('anchors the decision at the OUTERMOST time so ordering survives long inner calls', () => {
    // A slow inner call starting long before a later, quick decision would
    // re-order the sequence if the INNER timestamp were used.
    const { events } = collapseSpawnsToDecisions([
      row('a1', 'dev:pg_query', 'sp-1', '2026-08-09T00:00:00.000Z'),
      row('a1', 'code:run', 'sp-1', '2026-08-09T00:00:30.000Z'),
      row('a1', 'work_items:get', 'sp-2', '2026-08-09T00:00:10.000Z'),
    ]);
    const ordered = [...events].sort((a, b) => a.at - b.at).map((e) => e.symbol);
    expect(ordered).toEqual(['work_items:get', 'code:run']);
  });

  it('keeps different agents and different spawns separate', () => {
    const { events } = collapseSpawnsToDecisions([
      row('a1', 'x', 'sp-1', '2026-08-09T00:00:00.000Z'),
      row('a2', 'y', 'sp-2', '2026-08-09T00:00:00.000Z'),
    ]);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.cohort))).toEqual(new Set(['a1', 'a2']));
  });

  it('is insensitive to the order rows arrive in', () => {
    const rows = [
      row('a1', 'code:run', 'sp-1', '2026-08-09T00:00:30.136Z'),
      row('a1', 'events:cancel', 'sp-1', '2026-08-09T00:00:00.258Z'),
    ];
    expect(collapseSpawnsToDecisions(rows).events[0]!.symbol).toBe('code:run');
    expect(collapseSpawnsToDecisions([...rows].reverse()).events[0]!.symbol).toBe('code:run');
  });
});

describe('the provenance rule end-to-end', () => {
  /**
   * REGRESSION CONTROL for the defect this module exists to avoid, and which is
   * already live in the sibling co-occurrence miner: if a composite tool's
   * in_process fan-out were admitted, the top mined "pattern" would be that
   * ONE existing tool's own internals.
   *
   * The production query filters in_process out in SQL, so this test models what
   * WOULD happen if it did not — proving the filter is load-bearing rather than
   * decorative.
   */
  const orientFanout = (agent: string, tSec: number) => [
    row(agent, 'fleet:assignments', `sp-${agent}-${tSec}`, `2026-08-09T00:${String(tSec).padStart(2, '0')}:00.100Z`),
    row(agent, 'coord:inbox', `sp-${agent}-${tSec}`, `2026-08-09T00:${String(tSec).padStart(2, '0')}:00.200Z`),
    row(agent, 'memory:search', `sp-${agent}-${tSec}`, `2026-08-09T00:${String(tSec).padStart(2, '0')}:00.300Z`),
    row(agent, 'coord:whoami', `sp-${agent}-${tSec}`, `2026-08-09T00:${String(tSec).padStart(2, '0')}:00.400Z`),
    row(agent, 'coord:orient', `sp-${agent}-${tSec}`, `2026-08-09T00:${String(tSec).padStart(2, '0')}:00.500Z`),
  ];

  it('collapses a composite tool fan-out to the ONE call the agent made', () => {
    const rows = ['a1', 'a2', 'a3', 'a4'].flatMap((a) => [
      ...orientFanout(a, 1),
      ...orientFanout(a, 2),
    ]);
    const { events } = collapseSpawnsToDecisions(rows);
    // 4 agents x 2 orients = 8 decisions, not 40 rows.
    expect(events).toHaveLength(8);
    expect(new Set(events.map((e) => e.symbol))).toEqual(new Set(['coord:orient']));

    // And so the internals never surface as a "pattern across 4 agents".
    const mined = minePatternsFromEvents(events, { gapMs: 120_000 }, {
      minOccurrences: 3,
      minCohorts: 3,
      minLift: 0,
    });
    for (const p of mined.patterns) {
      expect(p.symbols).not.toContain('memory:search');
      expect(p.symbols).not.toContain('coord:whoami');
    }
  });
});

describe('sequenceId', () => {
  it('renders a stable kebab id in the recipe-id shape', () => {
    expect(sequenceId(['plans:add-decision', 'coord:send'])).toBe('plans-add-decision--coord-send');
  });

  it('is order-sensitive — a different order is a different pattern', () => {
    expect(sequenceId(['a:b', 'c:d'])).not.toBe(sequenceId(['c:d', 'a:b']));
  });

  it('never emits a colon, so it cannot collide with a raw ns:verb tool name', () => {
    expect(sequenceId(['work_items:get', 'work_items:complete'])).not.toContain(':');
  });
});
