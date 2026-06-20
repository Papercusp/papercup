/**
 * Unit tests for structural-error-verifier (EI-1747) — the pure decision core + the
 * injected-deps orchestration. No PG, no clock: the I/O seam is faked.
 */
import { describe, it, expect } from 'vitest';
import {
  decideStructuralAutoResolve,
  runStructuralErrorVerifierOnce,
  type OpenStructuralItem,
  type StructuralVerifierDeps,
} from './structural-error-verifier';

const HOUR = 60 * 60 * 1000;
const WINDOW = 6 * HOUR;

describe('decideStructuralAutoResolve (pure)', () => {
  it('resolves only when zero recurrences AND the item is older than the window', () => {
    expect(decideStructuralAutoResolve({ recentRecurrences: 0, itemAgeMs: 7 * HOUR, windowMs: WINDOW })).toBe(true);
  });

  it('keeps open when the error has recurred within the window (even if old)', () => {
    expect(decideStructuralAutoResolve({ recentRecurrences: 1, itemAgeMs: 99 * HOUR, windowMs: WINDOW })).toBe(false);
    expect(decideStructuralAutoResolve({ recentRecurrences: 12, itemAgeMs: 7 * HOUR, windowMs: WINDOW })).toBe(false);
  });

  it('keeps open a YOUNG item even with zero recurrences (not enough quiet time yet)', () => {
    expect(decideStructuralAutoResolve({ recentRecurrences: 0, itemAgeMs: 1 * HOUR, windowMs: WINDOW })).toBe(false);
    // exactly at the boundary: age == window counts as old-enough.
    expect(decideStructuralAutoResolve({ recentRecurrences: 0, itemAgeMs: WINDOW, windowMs: WINDOW })).toBe(true);
  });
});

/** A scripted fake of the I/O seam: `errorsByTool` drives the recurrence count; resolves
 *  are recorded so a test can assert exactly which items were closed. */
function makeFakeDeps(
  items: OpenStructuralItem[],
  errorsByTool: Record<string, number>,
  opts: { throwCountFor?: string } = {},
): StructuralVerifierDeps & { resolved: string[] } {
  const resolved: string[] = [];
  return {
    resolved,
    async selectOpenStructuralItems() {
      return items;
    },
    async countRecentToolErrors(tool) {
      if (opts.throwCountFor && tool === opts.throwCountFor) throw new Error('telemetry read failed');
      return errorsByTool[tool] ?? 0;
    },
    async resolveItem(_ws, issueId) {
      resolved.push(issueId);
    },
  };
}

const item = (issueId: string, tool: string, ageMs: number): OpenStructuralItem => ({
  workspaceId: 'ws',
  issueId,
  tool,
  watchdogKey: `repeated-tool-error:${tool}:structural`,
  ageMs,
});

describe('runStructuralErrorVerifierOnce (orchestration)', () => {
  it('resolves the quiet+old items and keeps the still-erroring / young ones', async () => {
    const items = [
      item('EI-1', 'plans:lint', 9 * HOUR), // old, quiet → resolve
      item('EI-2', 'fleet:place_batch', 9 * HOUR), // old, still erroring → keep
      item('EI-3', 'memory:update', 2 * HOUR), // young, quiet → keep
    ];
    const deps = makeFakeDeps(items, { 'fleet:place_batch': 4 });
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });

    expect(r).toEqual({ checked: 3, resolved: 1, kept: 2, errored: 0 });
    expect(deps.resolved).toEqual(['EI-1']);
  });

  it('respects maxPerTick (only the first N items are processed)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`EI-${i}`, `tool:${i}`, 9 * HOUR));
    const deps = makeFakeDeps(items, {}); // all quiet+old
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW, maxPerTick: 2 });

    expect(r.checked).toBe(2);
    expect(r.resolved).toBe(2);
    expect(deps.resolved).toEqual(['EI-0', 'EI-1']);
  });

  it('swallows a per-item failure — one bad row never aborts the pass', async () => {
    const items = [
      item('EI-1', 'good:tool', 9 * HOUR), // quiet+old → resolve
      item('EI-2', 'bad:tool', 9 * HOUR), // count throws → counted as errored, not resolved
      item('EI-3', 'good:tool2', 9 * HOUR), // still processed after the throw → resolve
    ];
    const deps = makeFakeDeps(items, {}, { throwCountFor: 'bad:tool' });
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });

    expect(r).toEqual({ checked: 3, resolved: 2, kept: 0, errored: 1 });
    expect(deps.resolved).toEqual(['EI-1', 'EI-3']);
  });

  it('resolves nothing when the selector is empty', async () => {
    const deps = makeFakeDeps([], {});
    const r = await runStructuralErrorVerifierOnce(deps, { windowMs: WINDOW });
    expect(r).toEqual({ checked: 0, resolved: 0, kept: 0, errored: 0 });
  });
});
