import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Every typecheck npm script must route through the pc-heavy slot semaphore.
 *
 * ── WHY THIS GUARD EXISTS (EI-19480850505352533) ────────────────────────────
 *
 * `scripts/pc-heavy.sh` is a host-wide counting semaphore whose own header says
 * it exists so "N agents' vitest / tsc / test:affected runs stagger instead of
 * all landing on the shared 128-core box at once", and whose coalescing note
 * names this exact command: "many agents each running `npm run lint:tsc` to
 * confirm the same gate ... which is exactly how '~19 typecheck jobs queued'
 * became a fleet-wide chokepoint".
 *
 * It was nonetheless wired into the TEST scripts only. `lint:tsc` — the command
 * CLAUDE.md instructs every agent to run after every edit — invoked
 * `scripts/lint-tsc.mjs` directly, so typechecks were the one heavy command
 * with no admission control at all. Measured on this box 2026-08-12: ~14
 * concurrent `lint-tsc.mjs` processes, load1 213-220 on 128 cores, and a
 * two-sample cgroup delta showing a single typecheck starved to 0.10 cores. It
 * produced no output for 19 minutes and then completed clean once load fell.
 *
 * The failure SCALES WITH COMPLIANCE: the more agents follow the documented
 * post-edit discipline, the worse it gets. And a starved typecheck is
 * indistinguishable from a hung one — an empty log, no error — which invites
 * both "assume it passed" and "kill it and relaunch", the second of which adds
 * another unthrottled process.
 *
 * ── WHY IT SCANS RATHER THAN PINNING A LIST ─────────────────────────────────
 *
 * The bug was not that one script was wrong; it was that a whole FAMILY was
 * never wired up while the test scripts beside them were. Pinning today's six
 * names would pass the moment someone adds a seventh. This derives the
 * population from the scripts themselves — any script that shells out to a
 * `lint-tsc*.mjs` runner is in scope — so a NEW unthrottled typecheck script
 * fails here on the day it is added.
 *
 * Not in scope, deliberately:
 *  - Scripts that DELEGATE via `npm --workspace ... run typecheck` — they reach
 *    a wrapped script and wrapping both would just hold two slots for one job.
 *  - The release gate. green-checkpoint sets `PC_HEAVY_RELEASE_GATE=1`, which
 *    pc-heavy honours by exec'ing immediately (WI-6140), so the gate is exempt
 *    from ADMISSION at the wrapper, not by omission here.
 *  - Nested invocations. pc-heavy exports `PC_HEAVY_BYPASS=1` to its child, so a
 *    wrapped sweep spawning wrapped children cannot self-deadlock on slots.
 */

const ROOT_PKG = new URL('../../../package.json', import.meta.url);
const OPERATOR_CORE_PKG = new URL('../package.json', import.meta.url);

/** A script that shells out to one of the tsc-baseline runners. */
const INVOKES_TSC_RUNNER = /lint-tsc[\w-]*\.mjs/;
const ROUTES_THROUGH_PC_HEAVY = /pc-heavy\.sh/;

/**
 * Deliberate exemptions, each with a reason. EMPTY on purpose: there is no
 * known typecheck entrypoint that should bypass the semaphore. Adding an entry
 * here is a decision to let one heavy command run unadmitted — say why.
 */
const ALLOW: Record<string, string> = {};

const scriptsOf = (pkgUrl: URL): Record<string, string> => {
  const parsed = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
};

const unthrottledIn = (pkgUrl: URL): string[] =>
  Object.entries(scriptsOf(pkgUrl))
    .filter(([name, cmd]) => INVOKES_TSC_RUNNER.test(cmd) && !ROUTES_THROUGH_PC_HEAVY.test(cmd) && !(name in ALLOW))
    .map(([name, cmd]) => `${name}: ${cmd}`);

describe('typecheck scripts are admission-controlled', () => {
  it('every root script that runs a lint-tsc runner goes through pc-heavy', () => {
    expect(unthrottledIn(ROOT_PKG)).toEqual([]);
  });

  it('every operator-core script that runs a lint-tsc runner goes through pc-heavy', () => {
    expect(unthrottledIn(OPERATOR_CORE_PKG)).toEqual([]);
  });

  it('the guard can actually fail — a control that models the exact bug', () => {
    // Without this, both assertions above would also pass if the detector were
    // broken (e.g. a regex that matches nothing). This models the real defect:
    // the pre-fix `lint:tsc` line, verbatim.
    const buggy = { scripts: { 'lint:tsc': 'node scripts/lint-tsc.mjs' } };
    const offenders = Object.entries(buggy.scripts).filter(
      ([, cmd]) => INVOKES_TSC_RUNNER.test(cmd) && !ROUTES_THROUGH_PC_HEAVY.test(cmd),
    );
    expect(offenders).toHaveLength(1);
  });

  it('a delegating script is not falsely flagged', () => {
    // `typecheck:operator-core` shells to npm, not to a runner — it must not be
    // read as an offender, or the guard would demand double-wrapping.
    const delegating = 'npm --workspace @papercusp/operator-core run typecheck --';
    expect(INVOKES_TSC_RUNNER.test(delegating)).toBe(false);
  });

  it('the population it scans is non-empty, so an empty result means clean not absent', () => {
    // A scan-based guard that finds NOTHING to scan passes vacuously forever.
    // Assert the subject population actually exists in both manifests.
    const rootRunners = Object.values(scriptsOf(ROOT_PKG)).filter((c) => INVOKES_TSC_RUNNER.test(c));
    const coreRunners = Object.values(scriptsOf(OPERATOR_CORE_PKG)).filter((c) => INVOKES_TSC_RUNNER.test(c));
    expect(rootRunners.length).toBeGreaterThanOrEqual(6);
    expect(coreRunners.length).toBeGreaterThanOrEqual(1);
  });
});
