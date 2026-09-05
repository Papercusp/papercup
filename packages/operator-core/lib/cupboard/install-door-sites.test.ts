/**
 * Falsifiable door-coverage guard (D-045 §3a scope item 3, WI-2146325).
 *
 * The defect this exists to catch is not a broken door — it is a door that
 * quietly never reaches the release chain at all. That is exactly how P-009's
 * whole layer sat in the tree with zero production importers while every
 * per-module test stayed green: no test asked "who CALLS this?", so nothing
 * failed. A ninth install door added tomorrow would reintroduce it silently.
 *
 * So this reads the doors off disk rather than trusting a hand-kept list, and
 * fails on a door that does not go through `gateInstallDoor`. Its own positive
 * control is the site census: a glob that matched nothing, or fewer doors than
 * exist, would otherwise pass vacuously — the same false-zero that makes an
 * absence claim from a truncated search unsound.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DOOR_DIR = join(__dirname, '..', 'agent-tools', 'cupboard');

/**
 * Every install door, by file name. Named explicitly AND compared against the
 * directory listing below: the literal list is what makes a REMOVED door
 * visible, and the listing is what makes an ADDED one visible. Either alone is
 * half a guard.
 */
const INSTALL_DOOR_SITES = [
  'install-app.ts',
  'install-blueprint.ts',
  'install-goal.ts',
  'install-plan.ts',
  'install-plugin.ts',
  'install-recipe.ts',
  'install-rubric.ts',
  'install-template.ts',
] as const;

function doorsOnDisk(): string[] {
  return readdirSync(DOOR_DIR)
    .filter((name) => name.startsWith('install-') && name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

describe('install door coverage', () => {
  it('the census is non-empty and matches the declared sites', () => {
    const onDisk = doorsOnDisk();
    // Positive control: a glob that matched nothing would make every assertion
    // below pass while measuring no door at all.
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk).toEqual([...INSTALL_DOOR_SITES].sort());
  });

  it('every install door routes through the release-chain gate', () => {
    const missing = INSTALL_DOOR_SITES.filter((name) => {
      const source = readFileSync(join(DOOR_DIR, name), 'utf8');
      return !source.includes('gateInstallDoor');
    });
    expect(missing).toEqual([]);
  });

  /**
   * The refusal predicate, named so the guard and its control cannot drift.
   *
   * `[^{}]` — NOT `[\s\S]` — confines the search to the refusal branch's own
   * body. A dot-style match runs past the closing brace and finds the door's
   * trailing `return`, reporting a door that merely LOGS the refusal as
   * compliant; the sibling guard (commerce-door-sites.test.ts) was written that
   * way and its control caught it. This assertion also used to check only that
   * the `if (!gate.ok)` branch EXISTED, which passed for a branch with no
   * `return` in it at all.
   */
  const refusesOnGateRefusal = (source: string): boolean =>
    /if\s*\(!gate\.ok\)\s*\{[^{}]{0,400}?return\s/.test(source);

  it('every install door REFUSES on a gate refusal rather than continuing', () => {
    // Calling the gate and ignoring its verdict would satisfy the check above
    // while installing exactly as before — the failure mode a reachability
    // check alone cannot see.
    const notRefusing = INSTALL_DOOR_SITES.filter(
      (name) => !refusesOnGateRefusal(readFileSync(join(DOOR_DIR, name), 'utf8')),
    );
    expect(notRefusing).toEqual([]);
  });

  it('the refusal check CAN fail — a door that ignores the gate is caught', () => {
    // A permanent wrong-implementation control. Without it, a predicate that
    // matches every door — including a non-refusing one — is indistinguishable
    // from a working guard, because both report zero offenders.
    const ignoresVerdict = `
      const gate = await gateInstallDoor(req);
      if (!gate.ok) {
        logRefusal(gate.code);
      }
      return text({ ok: true });
    `;
    const honoursVerdict = `
      const gate = await gateInstallDoor(req);
      if (!gate.ok) {
        return text({ ok: false, error: gate.code });
      }
      return text({ ok: true });
    `;
    expect(refusesOnGateRefusal(ignoresVerdict)).toBe(false);
    expect(refusesOnGateRefusal(honoursVerdict)).toBe(true);
  });
});
