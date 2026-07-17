/**
 * The startup guards must actually be CALLED at boot (EI-10660).
 *
 * This test exists because of a specific, embarrassing failure: `validateActiveRoutines` was
 * written as an EI-2224 recurrence guard, given four passing unit tests, and documented with a
 * "Called by:" block naming two callers — and it had ZERO callers for its entire life. Every
 * test was green. The logic was correct. The verdict went nowhere.
 *
 * A GREEN UNIT TEST PROVES A CHECK *WORKS*. IT NEVER PROVES THE CHECK *RUNS*.
 * Nothing in a per-module test suite can tell the difference between a wired guard and an
 * orphaned one — which is why that difference needs its own test, here, at the call site.
 *
 * Why assert against source text rather than invoking the boot path: `runBootstrap()` starts
 * background tickers that must never touch the shared/native DB from a unit test (the same
 * reason serve.test.ts refuses to boot it). Importing it to observe the calls would be worse
 * than the bug. So we assert the wiring the only way that is safe here — the boot file must
 * name each guard. Crude, but it fails loudly the moment someone deletes a call site, which is
 * exactly the regression that went unnoticed for months.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bootSrc = readFileSync(join(__dirname, 'host-bootstrap.ts'), 'utf8');

/** Each guard, with the module it lives in — both must appear at the boot site. */
const STARTUP_GUARDS: Array<{ fn: string; module: string; catches: string }> = [
  {
    fn: 'validateHomeHarnessResolution',
    module: 'startup/validate-home-harness',
    catches: 'the HOME harness slug does not resolve — every fire-path 404s and goes dark',
  },
  {
    fn: 'validateActiveRoutines',
    module: 'startup/validate-active-routines',
    catches: 'an ACTIVE routine targets an unregistered harness — it 404s and goes dark',
  },
  {
    fn: 'validateDeclaredSingletons',
    module: 'startup/validate-declared-singletons',
    catches: 'a DECLARED learning loop has no routine row — it never runs, and never will',
  },
];

describe('host-bootstrap wires every startup guard', () => {
  for (const guard of STARTUP_GUARDS) {
    it(`calls ${guard.fn}() at boot — else: ${guard.catches}`, () => {
      expect(bootSrc).toContain(guard.module);
      // The call, not merely the import: an imported-but-uncalled guard is the EI-10660 bug.
      expect(bootSrc).toMatch(new RegExp(`${guard.fn}\\s*\\(`));
    });
  }

  it('keeps every guard fail-soft — a health check must never kill the boot', () => {
    // Each guard runs in its own try/catch IIFE. If a future edit lets one throw out of the
    // boot path, an unhandled rejection exits Node, embedded-PG goes down, and the app is dead
    // on launch (the BUG-1 failure the home-harness guard is already commented for).
    const catches = bootSrc.match(/catch\s*\(/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(STARTUP_GUARDS.length);
  });

  // [EI-727] Not a STARTUP_GUARDS entry (it doesn't live in its own startup/validate-*
  // module — it's a one-line pure predicate on agent-config.ts) but the same
  // called-not-just-imported wiring risk applies: a silently-orphaned boot warning is as
  // useless as an orphaned guard.
  it('calls agentCmdBootWarning() at boot — else a host with no AGENT_CMD/CLAUDE silently falls back to the broken omp -p default', () => {
    expect(bootSrc).toContain('agentCmdBootWarning');
    expect(bootSrc).toMatch(/agentCmdBootWarning\s*\(/);
  });
});
