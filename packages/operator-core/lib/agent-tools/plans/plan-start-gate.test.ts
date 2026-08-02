/**
 * plan-start-gate.test — plan-structured-inputs-2026-08-01 P-006 + P-007.
 *
 * Two jobs:
 *
 *   1. pin `mergePlanInputs` (the shallow-merge rule from D-008 Q2);
 *   2. THE DOOR-COVERAGE GUARD — the recurrence guard for this whole feature.
 *
 * (2) is the one that matters in six months. A start gate is only as good as its
 * least-wired door, and "someone adds a seventh way to start a plan and doesn't know
 * this gate exists" is the specific way this feature rots. So the registry is asserted
 * against the source: every listed door must still reach a gate entry point, and any
 * NEW caller of the scheduled-fire path must be registered as a door.
 *
 * Reading source text is a blunt instrument, and deliberately so — it survives
 * refactors that a mock-based test would not, and it fails loudly in the one case
 * that matters (a door quietly stops consulting the gate).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLAN_START_DOORS,
  PLAN_START_GATE_ENTRYPOINTS,
  mergePlanInputs,
} from './plan-start-gate';

// lib/agent-tools/plans/ → the package root (operator-core), which the registry
// paths are relative to.
const PKG_ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(PKG_ROOT, rel), 'utf8');

describe('mergePlanInputs — per-invocation overrides (D-008 Q2)', () => {
  it('overrides a top-level key outright', () => {
    expect(mergePlanInputs({ harness: 'a', paths: ['x'] }, { harness: 'b' })).toEqual({
      harness: 'b',
      paths: ['x'],
    });
  });

  it('REPLACES an array rather than appending — shallow by design', () => {
    // Deep-merging arbitrary schema shapes has no obviously-correct array semantics;
    // a caller who passes paths:['only'] must get exactly that.
    expect(mergePlanInputs({ paths: ['a', 'b', 'c'] }, { paths: ['only'] })).toEqual({
      paths: ['only'],
    });
  });

  it('ignores an explicit undefined so a partial override cannot blank a stored value', () => {
    expect(mergePlanInputs({ harness: 'a' }, { harness: undefined })).toEqual({ harness: 'a' });
  });

  it('no overrides ⇒ the stored values, untouched', () => {
    const stored = { harness: 'a' };
    expect(mergePlanInputs(stored, null)).toBe(stored);
    expect(mergePlanInputs(stored, undefined)).toBe(stored);
  });

  it('treats a non-object stored blob as an empty base', () => {
    expect(mergePlanInputs(null, { harness: 'b' })).toEqual({ harness: 'b' });
  });
});

describe('P-007 DOOR COVERAGE GUARD — every start door consults the gate', () => {
  it('registers at least the six known doors', () => {
    expect(PLAN_START_DOORS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(PLAN_START_DOORS.map((d) => [d.door, d.file]))(
    '%s (%s) reaches a gate entry point',
    (door, file) => {
      expect(existsSync(join(PKG_ROOT, file)), `${door}: registered file ${file} does not exist`).toBe(
        true,
      );
      const src = read(file);
      const hit = PLAN_START_GATE_ENTRYPOINTS.some((fn) => src.includes(fn));
      expect(
        hit,
        `${door} (${file}) no longer calls any of ${PLAN_START_GATE_ENTRYPOINTS.join(' / ')} — ` +
          `a plan can now be started through it without its required inputs being checked. ` +
          `Re-wire the door, or remove it from PLAN_START_DOORS if it genuinely cannot start a plan.`,
      ).toBe(true);
    },
  );

  it('any caller of the scheduled-fire path is a registered door', () => {
    // The reverse direction: catches a NEW way to fire a plan run that was added
    // without registering it here. Scoped to the known call sites rather than a tree
    // walk, so it stays fast and has no false positives from docs/tests.
    const CALLERS = [
      'lib/agent-tools/plans/run-now.ts',
      'lib/harness/routines/plan-run-action.ts',
    ];
    const registered = new Set(PLAN_START_DOORS.map((d) => d.file));
    for (const f of CALLERS) {
      if (!existsSync(join(PKG_ROOT, f))) continue;
      const src = read(f);
      if (!src.includes('runScheduledPlanFire')) continue;
      expect(
        registered.has(f),
        `${f} calls runScheduledPlanFire but is not in PLAN_START_DOORS — register it so the ` +
          `coverage guard checks it.`,
      ).toBe(true);
    }
  });
});
