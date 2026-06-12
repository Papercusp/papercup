import { describe, expect, it } from 'vitest';
import {
  aggregateZeroHits,
  demandCaptureBody,
  demandCaptureTitle,
  demandOptionsFromPayload,
  demandWatchdogKey,
  normalizeQuery,
  selectDemandCandidates,
  surfaceOfTool,
  type DemandEntry,
  type ZeroHitRow,
} from './miner-core';

const row = (over: Partial<ZeroHitRow> = {}): ZeroHitRow => ({
  toolName: 'docs:search',
  query: 'tauri bridge port',
  agent: 'spawn-a',
  invokedAt: '2026-06-10T10:00:00.000Z',
  ...over,
});

describe('surfaceOfTool', () => {
  it('maps the three mined search tools and rejects everything else', () => {
    expect(surfaceOfTool('docs:search')).toBe('docs');
    expect(surfaceOfTool('memory:search')).toBe('memory');
    expect(surfaceOfTool('plans:search')).toBe('plans');
    expect(surfaceOfTool('search:fulltext')).toBeNull();
    expect(surfaceOfTool('docs:get')).toBeNull();
  });
});

describe('normalizeQuery', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeQuery('  Tauri   Bridge\tPort ')).toBe('tauri bridge port');
  });
  it('strips one layer of wrapping quotes', () => {
    expect(normalizeQuery('"negative space"')).toBe('negative space');
    expect(normalizeQuery("'negative space'")).toBe('negative space');
  });
  it('drops too-short queries', () => {
    expect(normalizeQuery('ab')).toBe('');
    expect(normalizeQuery('  a ')).toBe('');
    expect(normalizeQuery('""')).toBe('');
  });
});

describe('aggregateZeroHits', () => {
  it('groups by (surface, normalized query) with counts, agents, and time bounds', () => {
    const entries = aggregateZeroHits([
      row({ query: 'Tauri Bridge Port', agent: 'a', invokedAt: '2026-06-10T10:00:00.000Z' }),
      row({ query: 'tauri  bridge port', agent: 'b', invokedAt: '2026-06-11T10:00:00.000Z' }),
      row({ query: 'tauri bridge port', agent: 'a', invokedAt: '2026-06-09T10:00:00.000Z' }),
      row({ toolName: 'plans:search', query: 'tauri bridge port', agent: 'a' }),
    ]);
    expect(entries).toHaveLength(2);
    const docs = entries.find((e) => e.surface === 'docs')!;
    expect(docs.queryNorm).toBe('tauri bridge port');
    expect(docs.missCount).toBe(3);
    expect(docs.distinctAgents).toBe(2);
    expect(docs.firstMissedAt).toBe('2026-06-09T10:00:00.000Z');
    expect(docs.lastMissedAt).toBe('2026-06-11T10:00:00.000Z');
    // Example query is the most recent raw spelling.
    expect(docs.exampleQuery).toBe('tauri  bridge port');
    const plans = entries.find((e) => e.surface === 'plans')!;
    expect(plans.missCount).toBe(1);
  });

  it('drops non-mined tools and noise queries, sorts hottest-first', () => {
    const entries = aggregateZeroHits([
      row({ toolName: 'search:fulltext' }),
      row({ query: 'ab' }),
      row({ query: 'rare query', agent: 'a' }),
      row({ query: 'hot query', agent: 'a' }),
      row({ query: 'hot query', agent: 'b' }),
    ]);
    expect(entries.map((e) => e.queryNorm)).toEqual(['hot query', 'rare query']);
  });
});

const entry = (over: Partial<DemandEntry> = {}): DemandEntry => ({
  surface: 'docs',
  queryNorm: 'tauri bridge port',
  exampleQuery: 'tauri bridge port',
  missCount: 5,
  distinctAgents: 3,
  firstMissedAt: '2026-06-09T10:00:00.000Z',
  lastMissedAt: '2026-06-11T10:00:00.000Z',
  ...over,
});

describe('selectDemandCandidates', () => {
  it('applies both fire bars, skips already-filed, and caps per tick', () => {
    const picked = selectDemandCandidates(
      [
        entry({ queryNorm: 'hot' }),
        entry({ queryNorm: 'filed', candidateImprovementId: 'EI-1' }),
        entry({ queryNorm: 'lonely', distinctAgents: 1 }),
        entry({ queryNorm: 'rare', missCount: 2 }),
        entry({ queryNorm: 'second' }),
        entry({ queryNorm: 'third-over-cap' }),
      ],
      { minMisses: 3, minAgents: 2, maxPerTick: 2 },
    );
    expect(picked.map((e) => e.queryNorm)).toEqual(['hot', 'second']);
  });

  it('maxPerTick 0 is mine-only (no candidates)', () => {
    expect(selectDemandCandidates([entry()], { maxPerTick: 0 })).toEqual([]);
  });
});

describe('capture rendering', () => {
  it('watchdogKey is the stable surface-scoped identity', () => {
    expect(demandWatchdogKey(entry())).toBe('negative-space:docs:tauri bridge port');
  });
  it('title is STABLE — no counts or timestamps', () => {
    const title = demandCaptureTitle(entry());
    expect(title).toBe('Missing knowledge: docs searches for "tauri bridge port" find nothing');
    expect(title).not.toMatch(/\d{4}-/);
  });
  it('body carries the evidence', () => {
    const body = demandCaptureBody(entry(), 30);
    expect(body).toContain('3 agent(s)');
    expect(body).toContain('5×');
    expect(body).toContain('30d');
    expect(body).toContain('2026-06-11T10:00:00.000Z');
  });
});

describe('demandOptionsFromPayload', () => {
  it('reads the tuning knobs, ignoring junk', () => {
    expect(
      demandOptionsFromPayload({ minMisses: 5, minAgents: 1, maxPerTick: 0, windowDays: 7, junk: 'x', negativeIgnored: -3 }),
    ).toEqual({ minMisses: 5, minAgents: 1, maxPerTick: 0, windowDays: 7 });
    expect(demandOptionsFromPayload(null)).toEqual({});
    expect(demandOptionsFromPayload({ minMisses: 'three' as unknown as number })).toEqual({});
    // windowDays 0 is meaningless — dropped, the tick falls back to the default.
    expect(demandOptionsFromPayload({ windowDays: 0 })).toEqual({});
  });
});
