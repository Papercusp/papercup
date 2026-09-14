import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { crossHiveSelfSweepHint } from './_mcp-host';

/**
 * EI-22387683489943406: a session confined to `sb-devboard-hive` fired `git-sync:run`
 * at the `portal` install, got a bare `harness_forbidden`, and filed a MAJOR bug
 * asserting "so WI-2142851 files remain uncommitted". The refusal was correct; the
 * CONSEQUENCE the caller inferred from it was not — `portal` runs its own durable
 * git-sync routine and committed that checkout 11 times in the following 100 minutes.
 *
 * The clamp is NOT the defect and these tests must never be "fixed" by widening it —
 * it is the cross-tenant boundary (P-006/P-007/P-008), and only PLATFORM_POT_SLUG
 * carries the narrow `isExplicitPlatformPotGitSyncTarget` exemption. What is asserted
 * here is only that the refusal says what happens NEXT, so the caller verifies instead
 * of escalating.
 */
describe('crossHiveSelfSweepHint', () => {
  it('tells a refused cross-hive git-sync:run that it lost latency, not work', () => {
    const hint = crossHiveSelfSweepHint('git-sync:run', 'portal', 'sb-devboard-hive');

    expect(hint).toContain('LATENCY, not work');
    // Both boundaries must be named: the install the caller aimed at, and the hive
    // that actually stopped them — otherwise they have to guess which is which.
    expect(hint).toContain('portal');
    expect(hint).toContain('sb-devboard-hive');
  });

  it('hands over the probe that settles it, rather than asking for trust', () => {
    // The reported bug was a claim about a CHECKOUT made from a TOOL REFUSAL. The
    // hint has to redirect the caller to the checkout itself, or the same wrong
    // inference is available on the next call.
    const hint = crossHiveSelfSweepHint('git-sync:run', 'portal', 'sb-devboard-hive');

    expect(hint).toContain('git -C');
    expect(hint).toContain('log -3');
  });

  it('does NOT promise a sweep — it names the condition that makes this a real problem', () => {
    // 6 of the 73 measured git-sync routines were stale, so an unconditional "your
    // work will be committed" would be false for ~8% of installs and would suppress
    // exactly the escalations that are warranted. The hint must stay falsifiable.
    const hint = crossHiveSelfSweepHint('git-sync:run', 'portal', 'sb-devboard-hive');

    expect(hint).toContain('Escalate only when');
    expect(hint).toMatch(/inactive or failing/);
    // ...and it must not assert the commit as an accomplished fact.
    expect(hint).not.toMatch(/will be committed|has been committed|is already committed/i);
  });

  // CONTROL. Every assertion above would still pass if the helper ignored `toolName`
  // and returned the hint unconditionally — which would staple git-sync advice onto
  // unrelated cross-hive refusals that have their own tailored routes.
  it('CONTROL: returns nothing for tools that do not sweep themselves', () => {
    for (const tool of ['work_items:get', 'work_items:claim', 'fleet:launch-on-plan', 'routines:list']) {
      expect(crossHiveSelfSweepHint(tool, 'portal', 'sb-devboard-hive'), `expected NO sweep hint for ${tool}`).toBe(
        '',
      );
    }
  });
});

describe('crossHiveSelfSweepHint wiring', () => {
  // A correct helper that nothing calls is invisible at runtime, and the unit tests
  // above cannot tell the difference. `_mcp-handler.ts` refuses a cross-hive target
  // through FOUR distinct refusal sites: the literal `harness` branch and the generic
  // harness-naming-arg sweep, each duplicated across the spawn-context clamp and the
  // dispatch clamp. git-sync:run can arrive at either kind — `installSlug` is caught
  // by the generic sweep, its `harness` alias by the literal branch — so a fix applied
  // to only one is half-live and reads as fully fixed.
  // Path is overridable so falsifiability can be proven against a MUTATED COPY outside
  // the tree (scripts/mutation-probe.sh), never by mutating this shared checkout — a
  // git-sync sweep commits the working tree on a timer and would commit the mutant.
  const source = readFileSync(
    process.env.CROSS_HIVE_SELF_SWEEP_HINT_SOURCE ?? join(__dirname, '_mcp-host.ts'),
    'utf8',
  );
  const lines = source.split('\n');

  it('is interpolated into every generic harness-naming-arg refusal (the installSlug path)', () => {
    const refusalLines = lines.filter((line) => line.includes('names a harness outside this session'));

    expect(refusalLines.length).toBeGreaterThanOrEqual(2);
    for (const line of refusalLines) {
      expect(
        line,
        `a generic harness-arg refusal does not call crossHiveSelfSweepHint: ${line.trim()}`,
      ).toContain('crossHiveSelfSweepHint(toolName, slug, scopeHive)');
    }
  });

  it('is interpolated into every literal `harness` refusal (the harness-alias path)', () => {
    const refusalLines = lines.filter(
      (line) => line.includes('harness_forbidden: harness "${') && line.includes("outside this session's hive"),
    );

    expect(refusalLines.length).toBeGreaterThanOrEqual(2);
    for (const line of refusalLines) {
      expect(line, `a literal harness refusal does not call crossHiveSelfSweepHint: ${line.trim()}`).toMatch(
        /crossHiveSelfSweepHint\(toolName, (requestedHarness|argHarness), scopeHive\)/,
      );
    }
  });
});
