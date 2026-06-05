/**
 * Unit coverage for blocked_by resolution + cycle detection (P-046).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveBlockedByRefs,
  detectDependencyCycle,
  type FeatureWithRawDeps,
  type FeatureRef,
} from './feature-deps';

const f = (id: string, title: string, blockedByRefs: string[] = []): FeatureWithRawDeps => ({
  id,
  title,
  blockedByRefs,
});

describe('resolveBlockedByRefs', () => {
  it('resolves an exact feature-id ref verbatim', () => {
    const batch = [f('F-2', 'Build UI', ['F-1'])];
    const existing: FeatureRef[] = [{ id: 'F-1', title: 'Build API' }];
    const r = resolveBlockedByRefs(batch, existing);
    expect(r.errors).toEqual([]);
    expect(r.resolved.get('F-2')).toEqual(['F-1']);
  });

  it('resolves a title ref to its canonical id (case-insensitive)', () => {
    const batch = [f('F-2', 'Build UI', ['build api'])];
    const existing: FeatureRef[] = [{ id: 'F-1', title: 'Build API' }];
    const r = resolveBlockedByRefs(batch, existing);
    expect(r.errors).toEqual([]);
    expect(r.resolved.get('F-2')).toEqual(['F-1']);
  });

  it('resolves refs that point at other features in the same batch', () => {
    const batch = [f('F-1', 'API', []), f('F-2', 'UI', ['API'])];
    const r = resolveBlockedByRefs(batch, []);
    expect(r.errors).toEqual([]);
    expect(r.resolved.get('F-2')).toEqual(['F-1']);
  });

  it('errors LOUDLY on an unresolvable ref', () => {
    const r = resolveBlockedByRefs([f('F-2', 'UI', ['F-nope'])], []);
    expect(r.resolved.get('F-2')).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('unresolvable');
    expect(r.errors[0]).toContain('F-nope');
  });

  it('errors on an ambiguous title (matches >1 feature)', () => {
    const existing: FeatureRef[] = [
      { id: 'F-1', title: 'Setup' },
      { id: 'F-2', title: 'Setup' },
    ];
    const r = resolveBlockedByRefs([f('F-3', 'Work', ['Setup'])], existing);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('ambiguous');
  });

  it('drops a self-edge without erroring and dedupes', () => {
    const batch = [f('F-1', 'Solo', ['F-1', 'F-2', 'F-2'])];
    const existing: FeatureRef[] = [{ id: 'F-2', title: 'Dep' }];
    const r = resolveBlockedByRefs(batch, existing);
    expect(r.errors).toEqual([]);
    expect(r.resolved.get('F-1')).toEqual(['F-2']);
  });

  it('an empty/whitespace ref is ignored', () => {
    const r = resolveBlockedByRefs([f('F-1', 'X', ['', '  '])], []);
    expect(r.errors).toEqual([]);
    expect(r.resolved.get('F-1')).toEqual([]);
  });
});

describe('detectDependencyCycle (Kahn)', () => {
  it('accepts a linear chain', () => {
    const edges = new Map<string, string[]>([
      ['F-1', []],
      ['F-2', ['F-1']],
      ['F-3', ['F-2']],
    ]);
    expect(detectDependencyCycle(edges).hasCycle).toBe(false);
  });

  it('accepts a diamond (no cycle)', () => {
    const edges = new Map<string, string[]>([
      ['A', []],
      ['B', ['A']],
      ['C', ['A']],
      ['D', ['B', 'C']],
    ]);
    expect(detectDependencyCycle(edges).hasCycle).toBe(false);
  });

  it('detects a direct 2-cycle', () => {
    const edges = new Map<string, string[]>([
      ['A', ['B']],
      ['B', ['A']],
    ]);
    const r = detectDependencyCycle(edges);
    expect(r.hasCycle).toBe(true);
    expect(r.cycleNodes).toEqual(['A', 'B']);
  });

  it('detects a longer cycle', () => {
    const edges = new Map<string, string[]>([
      ['A', ['C']],
      ['B', ['A']],
      ['C', ['B']],
    ]);
    expect(detectDependencyCycle(edges).hasCycle).toBe(true);
  });

  it('detects a self-loop', () => {
    const edges = new Map<string, string[]>([['A', ['A']]]);
    expect(detectDependencyCycle(edges).hasCycle).toBe(true);
  });

  it('catches a cycle spanning a blocker not present as its own key', () => {
    // F-2 blocked_by F-1; F-1 (existing, merged in) blocked_by F-2.
    const edges = new Map<string, string[]>([
      ['F-2', ['F-1']],
      ['F-1', ['F-2']],
    ]);
    expect(detectDependencyCycle(edges).hasCycle).toBe(true);
  });
});
