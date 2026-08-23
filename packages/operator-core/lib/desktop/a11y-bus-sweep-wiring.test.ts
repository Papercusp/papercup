/**
 * The a11y-bus sweep must stay WIRED into the reconcile routine.
 *
 * `a11y-bus-sweep.test.ts` proves the sweep POLICY is correct. It cannot notice
 * the failure that actually matters: delete the call site in
 * `task-reconcile-action.ts` and all of those tests still pass while the leak
 * quietly resumes. A reaper that stops running goes red nowhere — the process
 * count just starts climbing again, which is precisely how this leak went
 * unnoticed for days in the first place.
 *
 * The call site sits inside a module-scope `registerSystemAction` callback, so
 * there is nothing importable to assert against and the subject is the source
 * text. That makes the FIXTURE controls load-bearing: once the live assertion is
 * green it is no longer evidence that the judge CAN fail, so the deliberately
 * unwired fixtures below stay here permanently (sibling idiom:
 * `task-manager/agent-session-progress-wiring.test.ts`).
 *
 * Run: cd packages/operator-core && npx vitest run lib/desktop/a11y-bus-sweep-wiring.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/desktop → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ACTION = join(ROOT, 'packages/operator-core/lib/harness/routines/task-reconcile-action.ts');

/** An anchor proving the judge read the file it thinks it did, not an empty string. */
const ANCHOR = 'registerSystemAction';

const source = readFileSync(ACTION, 'utf8');

/** Wired the way production is. */
const WIRED_FIXTURE = `
  if (isMaintDue({ lastAtMs: lastA11ySweepAtMs, nowMs, intervalMs: A11Y_SWEEP_INTERVAL_MS })) {
    lastA11ySweepAtMs = nowMs;
    try {
      sweepHost((io) => sweepA11yBuses(io));
    } catch (err) {
      console.warn('[a11y-bus-sweep] sweep failed', err);
    }
  }
`;

/** Imported, but never called — the "dead code" regression this guard exists for. */
const IMPORTED_BUT_UNCALLED_FIXTURE = `
import { sweepA11yBuses } from '../../desktop/a11y-bus-sweep';
import { sweepHost } from '../../desktop/a11y-bus-sweep-io';
// ...and no call site anywhere.
`;

/** Called, but never on a schedule — runs once at import and never again. */
const UNSCHEDULED_FIXTURE = `
  sweepHost((io) => sweepA11yBuses(io));
`;

function importsSweep(text: string): boolean {
  return (
    /import\s*\{[^}]*\bsweepA11yBuses\b[^}]*\}\s*from\s*'[^']*a11y-bus-sweep'/.test(text) &&
    /import\s*\{[^}]*\bsweepHost\b[^}]*\}\s*from\s*'[^']*a11y-bus-sweep-io'/.test(text)
  );
}

function callsSweep(text: string): boolean {
  return /sweepHost\s*\(\s*\([^)]*\)\s*=>\s*sweepA11yBuses\s*\(/.test(text);
}

function callIsScheduled(text: string): boolean {
  return (
    /isMaintDue\(\{\s*lastAtMs:\s*lastA11ySweepAtMs[^}]*intervalMs:\s*A11Y_SWEEP_INTERVAL_MS/.test(text) &&
    callsSweep(text)
  );
}

describe('a11y-bus sweep wiring (live source)', () => {
  it('reads the real reconcile action', () => {
    expect(source).toContain(ANCHOR);
    expect(source.length).toBeGreaterThan(1000);
  });

  it('imports the sweep and its host IO', () => {
    expect(importsSweep(source)).toBe(true);
  });

  it('calls the sweep through the fail-closed host wrapper', () => {
    // sweepHost — not sweepA11yBuses directly — is what refuses when no X
    // display is visible. Calling the inner function straight would remove that
    // guard while leaving every policy test green.
    expect(callsSweep(source)).toBe(true);
  });

  it('runs it on the maintenance schedule, with its own watermark', () => {
    expect(callIsScheduled(source)).toBe(true);
  });

  it('declares an interval for it', () => {
    expect(/const A11Y_SWEEP_INTERVAL_MS\s*=/.test(source)).toBe(true);
  });

  it('never lets a sweep failure escape into the reconcile tick', () => {
    const call = source.slice(source.indexOf('lastA11ySweepAtMs = nowMs;'));
    expect(call.slice(0, 400)).toContain('try {');
    expect(call.slice(0, 400)).toContain('catch');
  });
});

describe('the judge is falsifiable (permanent fixture controls)', () => {
  it('accepts a correctly wired fixture', () => {
    expect(callIsScheduled(WIRED_FIXTURE)).toBe(true);
  });

  it('REJECTS an import with no call site', () => {
    expect(importsSweep(IMPORTED_BUT_UNCALLED_FIXTURE)).toBe(true);
    expect(callsSweep(IMPORTED_BUT_UNCALLED_FIXTURE)).toBe(false);
    expect(callIsScheduled(IMPORTED_BUT_UNCALLED_FIXTURE)).toBe(false);
  });

  it('REJECTS a call that is not on the schedule', () => {
    expect(callsSweep(UNSCHEDULED_FIXTURE)).toBe(true);
    expect(callIsScheduled(UNSCHEDULED_FIXTURE)).toBe(false);
  });

  it('REJECTS an empty source — the broken-instrument control', () => {
    expect(importsSweep('')).toBe(false);
    expect(callsSweep('')).toBe(false);
    expect(callIsScheduled('')).toBe(false);
  });
});
