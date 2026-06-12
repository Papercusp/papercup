/**
 * selectWedgeReapCandidates — the wedge auto-reap filter (liveness-hardening
 * P-010 / D-006, owner decision 2026-06-11). Pins: only tracked spawns with
 * OBSERVED output silent past the threshold reap; never-output spawns never
 * reap; in-flight reaps don't double-fire; the default threshold stays
 * generous (≥30min — bees stream thinking, but a long local tool call is
 * legitimately silent).
 */
import { describe, test, expect } from 'vitest';
import { selectWedgeReapCandidates, WEDGE_REAP_SILENT_MS } from './operator-spawn';

const NOW = 50_000_000_000;
const SILENT = 30 * 60_000;

function fixture() {
  const output = new Map<string, { at: number }>([
    ['s-wedged', { at: NOW - SILENT - 60_000 }], // silent 31min
    ['s-talking', { at: NOW - 30_000 }], // emitted 30s ago
    ['s-borderline', { at: NOW - SILENT + 1_000 }], // 29min — inside threshold
  ]);
  const tracked = new Set(['s-wedged', 's-talking', 's-borderline', 's-never-spoke']);
  return { output, tracked };
}

describe('selectWedgeReapCandidates', () => {
  test('only the silent-past-threshold spawn reaps', () => {
    const { output, tracked } = fixture();
    expect(selectWedgeReapCandidates(output, tracked, new Set(), NOW, SILENT)).toEqual([
      's-wedged',
    ]);
  });

  test('a spawn with NO observed output never reaps (absence ≠ wedge)', () => {
    const { tracked } = fixture();
    // s-never-spoke is tracked but has no output entry at all.
    expect(selectWedgeReapCandidates(new Map(), tracked, new Set(), NOW, SILENT)).toEqual([]);
  });

  test('an untracked (already-finished) spawn never reaps even with a stale entry', () => {
    const { output } = fixture();
    expect(selectWedgeReapCandidates(output, new Set(), new Set(), NOW, SILENT)).toEqual([]);
  });

  test('an in-flight reap does not double-fire', () => {
    const { output, tracked } = fixture();
    expect(
      selectWedgeReapCandidates(output, tracked, new Set(['s-wedged']), NOW, SILENT),
    ).toEqual([]);
  });

  test('the default threshold is generous (≥30min — D-006 long-tool-call absorption)', () => {
    expect(WEDGE_REAP_SILENT_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });
});
