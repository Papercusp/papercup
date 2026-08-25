/**
 * stale-quote-stamp.test.ts — state-plane-adoption-2026-08-02 P-011.
 *
 * Pure halves are tested over injected specs/rows (no PG, no registry global);
 * the resolver is tested with an injected reader against the REAL builtin
 * registry (registered on demand by the resolver itself — pure, in-memory).
 */
import { describe, expect, it } from 'vitest';
import {
  buildCellTokenIndex,
  detectQuotedCells,
  scoreStaleQuotes,
  resolveStaleQuoteStamps,
  staleQuotes,
  STALE_QUOTE_STAMPS_MAX,
  type CellSpecLike,
  type SenderReadRow,
} from './stale-quote-stamp';
import type { CellSpec } from '../../cell-registry';

// Type-level pin: the real registry rows must stay assignable to the structural
// slice this module consumes — the exact contract the resolve call site's
// lint:tsc check enforces (`buildCellTokenIndex(registry.listCellsUnchecked())`).
const _registryAssignable: readonly CellSpecLike[] = [] as CellSpec[];
void _registryAssignable;

const SPECS: CellSpecLike[] = [
  {
    cell: 'gate.greenCheckpoint.verdict',
    changeSignal: { tool: 'dev:pipeline_position', path: 'gate.consecutiveReds' },
    doorProjections: [
      { tool: 'release:deploy', path: 'gate.consecutiveReds' },
      { tool: 'routines:list', path: 'health.gate_health.consecutiveReds' },
    ],
  },
  {
    cell: 'deploy.3070.sha',
    // bare (undotted) path — must NOT become a matchable token
    changeSignal: { tool: 'dev:pipeline_position', path: 'deployedSha' },
    doorProjections: [{ tool: 'release:deploy', path: 'deploy.deployedSha' }],
  },
  {
    cell: 'host.memoryPressure',
    changeSignal: { tool: 'host:memory_pressure', path: 'memory.pressure' },
  },
];

describe('buildCellTokenIndex (P-011)', () => {
  it('derives dotted tokens from cell ids, changeSignal paths and door projections', () => {
    const idx = buildCellTokenIndex(SPECS);
    expect(idx.tokens.get('gate.greenCheckpoint.verdict')).toBe('gate.greenCheckpoint.verdict');
    expect(idx.tokens.get('gate.consecutiveReds')).toBe('gate.greenCheckpoint.verdict');
    expect(idx.tokens.get('health.gate_health.consecutiveReds')).toBe(
      'gate.greenCheckpoint.verdict',
    );
    expect(idx.tokens.get('deploy.deployedSha')).toBe('deploy.3070.sha');
    expect(idx.tokens.get('memory.pressure')).toBe('host.memoryPressure');
  });

  it('excludes bare (undotted) field names — they collide with ordinary payload prose', () => {
    const idx = buildCellTokenIndex(SPECS);
    expect(idx.tokens.has('deployedSha')).toBe(false);
  });

  it('drops a token claimed by two different cells instead of guessing', () => {
    const idx = buildCellTokenIndex([
      { cell: 'a.one', changeSignal: { tool: 't1', path: 'shared.dotted.path' } },
      { cell: 'b.two', changeSignal: { tool: 't2', path: 'shared.dotted.path' } },
    ]);
    expect(idx.tokens.has('shared.dotted.path')).toBe(false);
    // the unambiguous cell ids themselves are 5/6 chars — under the min — so
    // the ONLY candidate token was the shared path, and it must be gone.
    expect([...idx.tokens.keys()]).toEqual([]);
  });

  it('maps each cell to its door tools for the fresh-read check', () => {
    const idx = buildCellTokenIndex(SPECS);
    expect(idx.doorsByCell.get('gate.greenCheckpoint.verdict')).toEqual(
      expect.arrayContaining(['dev:pipeline_position', 'release:deploy', 'routines:list']),
    );
    expect(idx.doorTools).toEqual(
      expect.arrayContaining(['dev:pipeline_position', 'release:deploy', 'routines:list', 'host:memory_pressure']),
    );
  });

  it('tolerates the registry union: an event-signalled cell yields its id token, no door, no throw', () => {
    // Mirrors CellSpec's event arm ({ kind:'event', key }) — no tool, no path.
    // Before the guard this crashed claim() on an undefined path, and the outer
    // fail-soft catch silently disabled the whole stamp for every registry with
    // an event cell (TS2345 at the resolve call site was pointing at this).
    const idx = buildCellTokenIndex([
      ...SPECS,
      { cell: 'fleet.drain.progress', changeSignal: { kind: 'event', key: 'fleet:drained:slug' } },
    ]);
    expect(idx.tokens.get('fleet.drain.progress')).toBe('fleet.drain.progress');
    expect(idx.tokens.has('fleet:drained:slug')).toBe(false);
    expect(idx.doorsByCell.get('fleet.drain.progress')).toEqual([]);
  });
});

describe('detectQuotedCells (P-011)', () => {
  const idx = buildCellTokenIndex(SPECS);

  it('finds a cell id and a dotted payload path in section text', () => {
    const detected = detectQuotedCells(
      [
        { text: 'the gate is red — gate.consecutiveReds is 3, re-read before acting' },
        { text: 'plain prose with no cell reference at all' },
        { text: 'per state:read { cell: "deploy.3070.sha" } the pin moved' },
      ],
      idx,
    );
    expect(detected).toEqual([
      { section: 0, cell: 'gate.greenCheckpoint.verdict', token: 'gate.consecutiveReds' },
      { section: 2, cell: 'deploy.3070.sha', token: 'deploy.3070.sha' },
    ]);
  });

  it('de-duplicates per (section, cell) when one section names a cell two ways', () => {
    const detected = detectQuotedCells(
      [{ text: 'gate.greenCheckpoint.verdict / gate.consecutiveReds both name one cell' }],
      idx,
    );
    expect(detected).toHaveLength(1);
    expect(detected[0]!.cell).toBe('gate.greenCheckpoint.verdict');
  });

  it('returns [] on prose without tokens — the cost gate', () => {
    expect(detectQuotedCells([{ text: 'nothing relevant here' }], idx)).toEqual([]);
    expect(detectQuotedCells([{ text: undefined }], idx)).toEqual([]);
  });

  it('caps the detection list', () => {
    const sections = Array.from({ length: STALE_QUOTE_STAMPS_MAX + 5 }, () => ({
      text: 'gate.consecutiveReds',
    }));
    expect(detectQuotedCells(sections, idx).length).toBeLessThanOrEqual(STALE_QUOTE_STAMPS_MAX);
  });
});

describe('scoreStaleQuotes (P-011)', () => {
  const idx = buildCellTokenIndex(SPECS);
  const detected = [
    { section: 0, cell: 'gate.greenCheckpoint.verdict', token: 'gate.consecutiveReds' },
    { section: 1, cell: 'deploy.3070.sha', token: 'deploy.3070.sha' },
  ];

  it('stamps quoted-without-fresh-read when the window holds no read', () => {
    const stamps = scoreStaleQuotes(detected, [], idx);
    expect(stamps.map((s) => s.verdict)).toEqual([
      'quoted-without-fresh-read',
      'quoted-without-fresh-read',
    ]);
    expect(staleQuotes(stamps)).toHaveLength(2);
  });

  it('a state:read of the exact cell is fresh; other cells stay stale', () => {
    const reads: SenderReadRow[] = [
      { tool: 'state:read', args: { cell: 'gate.greenCheckpoint.verdict' } },
    ];
    const stamps = scoreStaleQuotes(detected, reads, idx);
    expect(stamps[0]!.verdict).toBe('fresh-read');
    expect(stamps[1]!.verdict).toBe('quoted-without-fresh-read');
  });

  it('a door call marks every cell that door projects as fresh (under-accuse)', () => {
    const reads: SenderReadRow[] = [{ tool: 'dev:pipeline_position', args: {} }];
    const stamps = scoreStaleQuotes(detected, reads, idx);
    // dev:pipeline_position projects BOTH cells in the fixture registry
    expect(stamps.map((s) => s.verdict)).toEqual(['fresh-read', 'fresh-read']);
  });

  /**
   * FALSIFIABILITY CONTROL — a deliberately wrong "always fresh" scorer, kept
   * permanently as the control the real subject must beat (the CLAUDE.md
   * mutation-probe tier for module logic). If the real scorer degenerated to
   * this shape, the no-reads test above would fail; this control proves the
   * assertion style CAN distinguish the two.
   */
  it('control: an always-fresh scorer is distinguishable from the real one', () => {
    const alwaysFresh = detected.map((d) => ({ ...d, verdict: 'fresh-read' as const }));
    expect(alwaysFresh.map((s) => s.verdict)).not.toEqual(
      scoreStaleQuotes(detected, [], idx).map((s) => s.verdict),
    );
  });
});

describe('resolveStaleQuoteStamps (P-011)', () => {
  const CITE = 'the gate: gate.consecutiveReds says 2 — acting on it';

  it('resolves against the real builtin registry with an injected reader', async () => {
    const stamps = await resolveStaleQuoteStamps(
      { selfOwnerId: 'su-test', sections: [{ text: CITE }], workspaceId: 'ws-1' },
      async () => [],
    );
    expect(stamps).toEqual([
      {
        section: 0,
        cell: 'gate.greenCheckpoint.verdict',
        token: 'gate.consecutiveReds',
        verdict: 'quoted-without-fresh-read',
      },
    ]);
  });

  it('an unreadable ledger yields NO stamps — unknown never accuses', async () => {
    const stamps = await resolveStaleQuoteStamps(
      { selfOwnerId: 'su-test', sections: [{ text: CITE }], workspaceId: 'ws-1' },
      async () => null,
    );
    expect(stamps).toEqual([]);
  });

  it('a throwing reader fails soft to []', async () => {
    const stamps = await resolveStaleQuoteStamps(
      { selfOwnerId: 'su-test', sections: [{ text: CITE }], workspaceId: 'ws-1' },
      async () => {
        throw new Error('pg down');
      },
    );
    expect(stamps).toEqual([]);
  });

  it('never reaches the reader when nothing is cited (the gate)', async () => {
    let readerCalls = 0;
    const stamps = await resolveStaleQuoteStamps(
      { selfOwnerId: 'su-test', sections: [{ text: 'no cells here' }], workspaceId: 'ws-1' },
      async () => {
        readerCalls += 1;
        return [];
      },
    );
    expect(stamps).toEqual([]);
    expect(readerCalls).toBe(0);
  });

  it('missing sender or workspace resolves to [] without IO', async () => {
    let readerCalls = 0;
    const reader = async () => {
      readerCalls += 1;
      return [] as SenderReadRow[];
    };
    expect(
      await resolveStaleQuoteStamps(
        { selfOwnerId: '', sections: [{ text: CITE }], workspaceId: 'ws-1' },
        reader,
      ),
    ).toEqual([]);
    expect(
      await resolveStaleQuoteStamps(
        { selfOwnerId: 'su-test', sections: [{ text: CITE }], workspaceId: null },
        reader,
      ),
    ).toEqual([]);
    expect(readerCalls).toBe(0);
  });
});
