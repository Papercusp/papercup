import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { crossHiveLaunchHint } from './_mcp-host';

/**
 * EI-22068944239934723: a hive-confined session asked fleet:launch-on-plan to act on
 * another hive's harness and got a bare `harness_forbidden` with no route, so it read a
 * wrong-door refusal as "this work cannot be done" and stopped.
 *
 * The clamp is NOT the defect and these tests must never be "fixed" by widening it — it
 * is the cross-tenant boundary (P-006/P-007/P-008). What is asserted here is only that
 * the refusal NAMES somewhere the work can legitimately go.
 */
describe('crossHiveLaunchHint', () => {
  it('routes a refused cross-hive fleet:launch-on-plan to the sanctioned cross-Pot path', () => {
    const hint = crossHiveLaunchHint('fleet:launch-on-plan', 'papercusp');

    expect(hint).toContain('discovery:pots');
    expect(hint).toContain('pot:request_work');
    // The refusal must name the hive the caller is actually confined to, so a reader
    // does not have to guess which boundary stopped them.
    expect(hint).toContain('papercusp');
  });

  it('pre-empts the wrong next move: `hive` is a cross-MACHINE knob, not a hive escape', () => {
    // Without this sentence the obvious next attempt is to re-run the same call with
    // `hive: '<other hive>'`, which is a seat-placement argument and cannot lift the
    // refusal — a second dead end costing another round trip.
    const hint = crossHiveLaunchHint('fleet:launch-on-plan', 'papercusp');

    expect(hint).toContain('cross-MACHINE');
    expect(hint).toContain('not a cross-hive harness escape');
  });

  it('covers the whole launch-shaped family, not just the one tool that was reported', () => {
    for (const tool of ['fleet:launch-on-plan', 'fleet:create', 'capability:launch-agent']) {
      expect(crossHiveLaunchHint(tool, 'papercusp'), `expected a route hint for ${tool}`).toContain(
        'pot:request_work',
      );
    }
  });

  // CONTROL. Every assertion above would still pass if the helper ignored `toolName`
  // and returned the hint unconditionally — which would staple launch advice onto
  // unrelated refusals (e.g. work_items:get, which has its own tailored route).
  it('CONTROL: returns nothing for tools that are not launch-shaped', () => {
    for (const tool of ['work_items:get', 'work_items:claim', 'plans:get', 'docs:search']) {
      expect(crossHiveLaunchHint(tool, 'papercusp'), `expected NO launch hint for ${tool}`).toBe('');
    }
  });
});

describe('crossHiveLaunchHint wiring', () => {
  // A correct helper that nothing calls is invisible at runtime, and the unit tests
  // above cannot tell the difference. `_mcp-handler.ts` builds the harness_forbidden
  // text in TWO places (the spawn-context clamp and the dispatch clamp); a fix applied
  // to only one of them is half-live and reads as fully fixed.
  // Path is overridable so falsifiability can be proven against a MUTATED COPY outside
  // the tree (scripts/mutation-probe.sh), never by mutating this shared checkout — a
  // git-sync sweep commits the working tree on a timer and would commit the mutant.
  const source = readFileSync(
    process.env.CROSS_HIVE_LAUNCH_HINT_SOURCE ?? join(__dirname, '_mcp-host.ts'),
    'utf8',
  );

  it('is interpolated into every harness_forbidden refusal that names a requested harness', () => {
    const refusalLines = source
      .split('\n')
      .filter(
        (line) =>
          line.includes('harness_forbidden: harness "${') && line.includes("outside this session's hive"),
      );

    expect(refusalLines.length).toBeGreaterThanOrEqual(2);
    for (const line of refusalLines) {
      expect(line, `a harness_forbidden refusal does not call crossHiveLaunchHint: ${line.trim()}`).toContain(
        'crossHiveLaunchHint(toolName, scopeHive)',
      );
    }
  });
});
