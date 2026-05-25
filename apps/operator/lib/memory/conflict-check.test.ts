import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkConflicts,
  buildConflictPrompt,
  parseConflictResponse,
  _testing,
  type LlmJudge,
  type NeighborMemory,
} from './conflict-check';

const origEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...origEnv, PAPERCUSP_MEMORY_CONFLICT_CHECK: 'on' };
});
afterEach(() => {
  process.env = origEnv;
});

describe('conflictCheckEnabled', () => {
  it('on when env=on', () => {
    process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK = 'on';
    expect(_testing.conflictCheckEnabled()).toBe(true);
  });

  it('off by default', () => {
    delete process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK;
    expect(_testing.conflictCheckEnabled()).toBe(false);
  });
});

describe('checkConflicts — gating', () => {
  it('returns empty when flag off', async () => {
    process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK = 'off';
    const judge = vi.fn(async () => ({ conflicts: [{ memory_id: 'm', summary: 's' }] }));
    const r = await checkConflicts({
      newText: 'foo',
      neighbors: [{ id: 'm1', text: 'bar' }],
      judge,
    });
    expect(r).toEqual({ conflicts: [] });
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns empty when no neighbors', async () => {
    const judge = vi.fn(async () => ({ conflicts: [] }));
    const r = await checkConflicts({ newText: 'foo', neighbors: [], judge });
    expect(r).toEqual({ conflicts: [] });
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('checkConflicts — happy path', () => {
  it('returns conflicts from judge', async () => {
    const judge: LlmJudge = vi.fn(async () => ({
      conflicts: [{ memory_id: 'm1', summary: 'opposes the new memory' }],
    }));
    const r = await checkConflicts({
      newText: 'Avi prefers vim',
      neighbors: [{ id: 'm1', text: 'Avi prefers emacs' }],
      judge,
    });
    expect(r.conflicts).toEqual([
      { memory_id: 'm1', summary: 'opposes the new memory' },
    ]);
  });

  it('filters out malformed conflict items', async () => {
    const judge: LlmJudge = vi.fn(async () => ({
      conflicts: [
        { memory_id: 'good', summary: 's' },
        { memory_id: '', summary: 's' }, // empty id → filtered
        { memory_id: 'no-summary' } as unknown as { memory_id: string; summary: string }, // missing summary
        { memory_id: 'good2', summary: 's2' },
      ],
    }));
    const r = await checkConflicts({
      newText: 'x',
      neighbors: [{ id: 'n', text: 'y' }],
      judge,
    });
    expect(r.conflicts.map((c) => c.memory_id)).toEqual(['good', 'good2']);
  });
});

describe('checkConflicts — failure handling', () => {
  it('returns empty when judge throws', async () => {
    const judge: LlmJudge = vi.fn(async () => { throw new Error('LLM timeout'); });
    const r = await checkConflicts({
      newText: 'x',
      neighbors: [{ id: 'n', text: 'y' }],
      judge,
    });
    expect(r).toEqual({ conflicts: [] });
  });

  it('returns empty when judge returns null', async () => {
    const judge: LlmJudge = vi.fn(async () => null as unknown as { conflicts: never[] });
    const r = await checkConflicts({
      newText: 'x',
      neighbors: [{ id: 'n', text: 'y' }],
      judge,
    });
    expect(r).toEqual({ conflicts: [] });
  });
});

describe('buildConflictPrompt', () => {
  it('lists neighbors with index + id + text', () => {
    const neighbors: NeighborMemory[] = [
      { id: 'm1', text: 'Avi prefers emacs' },
      { id: 'm2', text: 'unrelated fact' },
    ];
    const p = buildConflictPrompt({ newText: 'Avi prefers vim', neighbors });
    expect(p).toContain('NEW memory:\nAvi prefers vim');
    expect(p).toContain('[1] id=m1: Avi prefers emacs');
    expect(p).toContain('[2] id=m2: unrelated fact');
    expect(p).toContain('{"conflicts": [{"memory_id":');
  });
});

describe('parseConflictResponse', () => {
  it('parses bare JSON', () => {
    expect(parseConflictResponse('{"conflicts": []}')).toEqual({ conflicts: [] });
  });

  it('parses JSON with one conflict', () => {
    expect(
      parseConflictResponse('{"conflicts": [{"memory_id": "m1", "summary": "why"}]}'),
    ).toEqual({ conflicts: [{ memory_id: 'm1', summary: 'why' }] });
  });

  it('strips ```json code fences', () => {
    expect(
      parseConflictResponse('```json\n{"conflicts": []}\n```'),
    ).toEqual({ conflicts: [] });
  });

  it('strips plain ``` fences', () => {
    expect(
      parseConflictResponse('```\n{"conflicts": []}\n```'),
    ).toEqual({ conflicts: [] });
  });

  it('extracts JSON from surrounding prose', () => {
    expect(
      parseConflictResponse('Sure! Here you go:\n{"conflicts": []}\nLet me know if you need more.'),
    ).toEqual({ conflicts: [] });
  });

  it('returns empty on parse failure', () => {
    expect(parseConflictResponse('not json at all')).toEqual({ conflicts: [] });
    expect(parseConflictResponse('')).toEqual({ conflicts: [] });
    expect(parseConflictResponse('{bad json}')).toEqual({ conflicts: [] });
  });

  it('returns empty when conflicts field missing', () => {
    expect(parseConflictResponse('{"foo": "bar"}')).toEqual({ conflicts: [] });
  });

  it('filters malformed conflict entries', () => {
    const r = parseConflictResponse(
      JSON.stringify({
        conflicts: [
          { memory_id: 'good', summary: 's' },
          { memory_id: '', summary: 's' },
          { memory_id: 'no-summary' },
          'not even an object',
          { memory_id: 'good2', summary: 's2' },
        ],
      }),
    );
    expect(r.conflicts.map((c) => c.memory_id)).toEqual(['good', 'good2']);
  });
});
