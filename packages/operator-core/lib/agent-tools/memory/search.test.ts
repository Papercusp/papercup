/**
 * Tests for toWireRow — the MemoryEntry → stable wire-row mapper that the
 * memory:search response and the TUI Memory tab consume (byte-stable contract).
 * Run with:
 *   cd packages/operator-core && npx vitest run lib/agent-tools/memory/search.test.ts
 */
import { describe, expect, it } from 'vitest';
import { toWireRow } from './search';
import type { MemoryEntry } from '../../memory/backend';

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: 'm1',
  text: 'the user prefers nuqs',
  scope: 'user',
  ...over,
});

describe('toWireRow', () => {
  it('maps id→id and text→memory; omits metadata/score when absent', () => {
    expect(toWireRow(entry())).toEqual({ id: 'm1', memory: 'the user prefers nuqs' });
  });

  it('passes metadata through untouched when there is no kind', () => {
    const meta = { anchor: 'F-001', ts: 123 };
    expect(toWireRow(entry({ metadata: meta }))).toEqual({
      id: 'm1',
      memory: 'the user prefers nuqs',
      metadata: meta,
    });
  });

  it('materializes kind into metadata.kind when there is no metadata', () => {
    expect(toWireRow(entry({ kind: 'preference' }))).toEqual({
      id: 'm1',
      memory: 'the user prefers nuqs',
      metadata: { kind: 'preference' },
    });
  });

  it('merges kind into existing metadata (kind takes precedence)', () => {
    const out = toWireRow(entry({ kind: 'correction', metadata: { anchor: 'x', kind: 'stale' } }));
    expect(out.metadata).toEqual({ anchor: 'x', kind: 'correction' });
  });

  it('does not mutate the source entry metadata', () => {
    const meta = { anchor: 'x' };
    toWireRow(entry({ kind: 'preference', metadata: meta }));
    expect(meta).toEqual({ anchor: 'x' });
  });

  it('includes score when present and omits it when undefined', () => {
    expect(toWireRow(entry({ score: 0.87 })).score).toBe(0.87);
    expect('score' in toWireRow(entry())).toBe(false);
  });

  it('preserves a score of 0 (not dropped as falsy)', () => {
    expect(toWireRow(entry({ score: 0 })).score).toBe(0);
  });
});
