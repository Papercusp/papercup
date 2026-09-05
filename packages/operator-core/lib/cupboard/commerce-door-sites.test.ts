/**
 * Falsifiable door-coverage guard for the four P-011 commerce doors
 * (D-045 §3d, WI-2146326) — the sibling of `install-door-sites.test.ts`.
 *
 * The defect this exists to catch is not a broken door — it is a door that
 * quietly never reaches the gate at all. That is exactly how P-010/P-011 sat in
 * the tree with zero production importers while every per-module test stayed
 * green (WI-2146273): no test asked "who CALLS this?", so nothing failed.
 *
 * Three assertions, because any two of them pass for a broken tree:
 *   1. the census is non-empty and matches the declared sites — without it a
 *      glob matching nothing makes 2 and 3 pass vacuously;
 *   2. each door calls its door function — reachability;
 *   3. each door RETURNS on the refusal branch — a door that calls the gate and
 *      ignores a refusal satisfies 2 while behaving exactly as if ungated.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DOOR_DIR = join(__dirname, '..', 'agent-tools', 'cupboard');
const REGISTRY = join(__dirname, '..', 'agent-tools', 'index.ts');

/**
 * Every commerce door, with the `commerce-door-gate-io` entry point it must
 * reach. Named explicitly AND compared against the directory listing: the
 * literal list makes a REMOVED door visible, the listing makes an ADDED one
 * visible. Either alone is half a guard.
 */
const COMMERCE_DOOR_SITES: ReadonlyArray<readonly [file: string, entryPoint: string]> = [
  ['checkout.ts', 'checkoutDoor'],
  ['commerce-dashboards.ts', 'commerceDashboardsDoor'],
  ['refund-request.ts', 'refundRequestDoor'],
  ['support-request.ts', 'supportRequestDoor'],
];

const COMMERCE_DOOR_FILES = COMMERCE_DOOR_SITES.map(([file]) => file);

function doorsOnDisk(): string[] {
  const declared = new Set(COMMERCE_DOOR_FILES);
  return readdirSync(DOOR_DIR)
    .filter((name) => declared.has(name))
    .sort();
}

function sourceOf(file: string): string {
  return readFileSync(join(DOOR_DIR, file), 'utf8');
}

describe('commerce door coverage', () => {
  it('the census is non-empty and every declared door exists on disk', () => {
    const onDisk = doorsOnDisk();
    // Positive control: a listing that matched nothing would make every
    // assertion below pass while measuring no door at all.
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk).toEqual([...COMMERCE_DOOR_FILES].sort());
  });

  it('every commerce door routes through commerce-door-gate-io', () => {
    const missing = COMMERCE_DOOR_SITES.filter(([file, entryPoint]) => {
      const source = sourceOf(file);
      return !source.includes('commerce-door-gate-io') || !source.includes(entryPoint);
    }).map(([file]) => file);
    expect(missing).toEqual([]);
  });

  /**
   * The predicate the refusal check uses, named so the guard and its own
   * falsifiability control cannot drift apart — a control that re-types the
   * regex proves the copy works, not the guard.
   */
  const refusesOnRefusal = (source: string): boolean =>
    // `[^{}]` — NOT `[\s\S]` — is the whole point. A dot-style match runs past
    // the block's closing brace and finds the door's trailing `return`, so it
    // reports a door that merely LOGS the refusal as compliant. The control
    // below caught exactly that; the character class is what confines the
    // search to the refusal branch's own body.
    /if\s*\(!(decision|outcome)\.ok\)\s*\{[^{}]{0,400}?return\s/.test(source);

  it('every commerce door RETURNS on a refusal rather than continuing', () => {
    // Calling the gate and ignoring its verdict would satisfy the check above
    // while authorizing nothing — the failure a reachability check cannot see.
    expect(COMMERCE_DOOR_FILES.filter((file) => !refusesOnRefusal(sourceOf(file)))).toEqual([]);
  });

  it('the refusal check CAN fail — a door that ignores the verdict is caught', () => {
    // A permanent wrong-implementation control, kept in the test rather than
    // produced by mutating the shared tree (a mutation probe there can be swept
    // into a commit by git-sync while the suite runs). Without this, a regex
    // that matched everything — or nothing but happened to be tested only
    // against compliant files — would look identical to a working guard.
    const ignoresVerdict = `
      const decision = await refundRequestDoor(input);
      if (!decision.ok) {
        recordRefusal(decision.code);
      }
      return text({ ok: true });
    `;
    const honoursVerdict = `
      const decision = await refundRequestDoor(input);
      if (!decision.ok) {
        return text({ ok: false, error: decision.code });
      }
      return text({ ok: true });
    `;
    expect(refusesOnRefusal(ignoresVerdict)).toBe(false);
    expect(refusesOnRefusal(honoursVerdict)).toBe(true);
  });

  it('every commerce door is REGISTERED — an unimported door is unreachable', () => {
    // The gap that made this whole plan item necessary: a door can be perfect
    // and still have no production caller if nothing imports it.
    const registry = readFileSync(REGISTRY, 'utf8');
    const unregistered = COMMERCE_DOOR_FILES.filter(
      (file) => !registry.includes(`./cupboard/${file.replace(/\.ts$/, '')}`),
    );
    expect(unregistered).toEqual([]);
  });

  it('the registry check can FAIL — a name absent from it is reported', () => {
    // Calibration for the case above: if the substring test matched anything,
    // the registry assertion would pass for a door nobody imports.
    const registry = readFileSync(REGISTRY, 'utf8');
    expect(registry.includes('./cupboard/definitely-not-a-door')).toBe(false);
  });
});
