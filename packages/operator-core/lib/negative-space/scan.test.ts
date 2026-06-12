import { describe, expect, it, vi } from 'vitest';
import { runNegativeSpaceTick, DEFAULT_WINDOW_DAYS, type NegativeSpaceTickDeps } from './scan';
import type { DemandEntry, ZeroHitRow } from './miner-core';
import type { CaptureImprovementResult } from '../harness/improvements/capture-core';

const zeroHit = (query: string, agent: string, invokedAt = '2026-06-11T10:00:00.000Z'): ZeroHitRow => ({
  toolName: 'docs:search',
  query,
  agent,
  invokedAt,
});

const createdResult = (id: string): CaptureImprovementResult => ({
  ok: true,
  created: true,
  issue: { id } as CaptureImprovementResult['issue'],
  possibleDuplicates: [],
});

const declinedResult: CaptureImprovementResult = {
  ok: true,
  created: false,
  reason: 'likely-duplicate',
  possibleDuplicates: [{ id: 'EI-9', title: 't', state: 'open', severity: 'minor', similarity: 0.8 }],
};

function makeDeps(rows: ZeroHitRow[], over: Partial<NegativeSpaceTickDeps> = {}) {
  const readRows = vi.fn<NegativeSpaceTickDeps['readRows']>(async () => rows);
  const persist = vi.fn<NegativeSpaceTickDeps['persist']>(async (_ws, entries) => entries);
  const capture = vi.fn<NegativeSpaceTickDeps['capture']>(async () => createdResult('EI-100'));
  const markFiled = vi.fn<NegativeSpaceTickDeps['markFiled']>(async () => {});
  const deps: NegativeSpaceTickDeps = { readRows, persist, capture, markFiled, log: () => {}, ...over };
  return { deps, readRows, persist, capture, markFiled };
}

describe('runNegativeSpaceTick', () => {
  it('reads the window, persists the aggregated map, files candidates over the bars, stamps filed ids', async () => {
    const rows = [
      zeroHit('hot query', 'a'),
      zeroHit('hot query', 'b'),
      zeroHit('hot query', 'a'),
      zeroHit('lonely query', 'a'),
    ];
    const { deps, readRows, persist, capture, markFiled } = makeDeps(rows);
    const result = await runNegativeSpaceTick('ws-1', deps, { minMisses: 3, minAgents: 2, maxPerTick: 2 });

    expect(readRows).toHaveBeenCalledWith('ws-1', DEFAULT_WINDOW_DAYS);
    expect(persist).toHaveBeenCalledOnce();
    const persisted = persist.mock.calls[0]![1];
    expect(persisted.map((e) => e.queryNorm).sort()).toEqual(['hot query', 'lonely query']);

    // Only "hot query" crosses both bars (3 misses, 2 agents).
    expect(capture).toHaveBeenCalledOnce();
    const input = capture.mock.calls[0]![0];
    expect(input.kind).toBe('change');
    expect(input.watchdogKey).toBe('negative-space:docs:hot query');
    expect(input.dedupScope).toBe('open');
    expect(input.evidenceAt).toBe('2026-06-11T10:00:00.000Z');
    expect(input.sourceRole).toBe('system');

    expect(markFiled).toHaveBeenCalledWith('ws-1', expect.objectContaining({ queryNorm: 'hot query' }), 'EI-100');
    expect(result).toEqual({ scanned: 4, demandEntries: 2, filed: ['EI-100'], declined: 0 });
  });

  it('honors the per-tick cap and the windowDays option', async () => {
    const rows = ['q-one', 'q-two', 'q-three'].flatMap((q) => [zeroHit(q, 'a'), zeroHit(q, 'b'), zeroHit(q, 'c')]);
    const { deps, readRows, capture } = makeDeps(rows);
    const result = await runNegativeSpaceTick('ws-1', deps, { windowDays: 7, maxPerTick: 1 });
    expect(readRows).toHaveBeenCalledWith('ws-1', 7);
    expect(capture).toHaveBeenCalledOnce();
    expect(result.filed).toHaveLength(1);
  });

  it('a candidate already filed on the persisted map never re-files', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps, capture } = makeDeps(rows, {
      // persist merges a prior filed id back in (the PG leg's carry-forward).
      persist: async (_ws, entries) => entries.map((e) => ({ ...e, candidateImprovementId: 'EI-7' })),
    });
    const result = await runNegativeSpaceTick('ws-1', deps);
    expect(capture).not.toHaveBeenCalled();
    expect(result.filed).toEqual([]);
  });

  it('a capture-core decline counts as declined and never stamps', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps, markFiled } = makeDeps(rows, { capture: async () => declinedResult });
    const result = await runNegativeSpaceTick('ws-1', deps);
    expect(result.declined).toBe(1);
    expect(result.filed).toEqual([]);
    expect(markFiled).not.toHaveBeenCalled();
  });

  it('a capture throw is best-effort — the tick completes and reports it declined', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps } = makeDeps(rows, {
      capture: async () => {
        throw new Error('pg down');
      },
    });
    const result = await runNegativeSpaceTick('ws-1', deps);
    expect(result.declined).toBe(1);
    expect(result.demandEntries).toBe(1);
  });

  it('mine-only mode (maxPerTick 0) persists the map and files nothing', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps, persist, capture } = makeDeps(rows);
    const result = await runNegativeSpaceTick('ws-1', deps, { maxPerTick: 0 });
    expect(persist).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(result).toMatchObject({ demandEntries: 1, filed: [] });
  });
});
