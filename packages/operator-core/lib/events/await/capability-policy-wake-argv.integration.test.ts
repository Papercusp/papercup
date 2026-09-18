/**
 * INTEGRATION (wake/resume surface): the ONE capability policy must reach the
 * argv the wake executor actually resumes a claude session with — plan
 * managed-agent-capability-contract-and-native-cutover-2026-09-13 P-005.
 *
 * ## This is the site the P-005 defect actually lived at
 *
 * The headless LAUNCH site pushed four restrictions; this WAKE site pushed
 * three. `notify-send` was therefore denied at every launch and silently
 * regained on the first autonomous wake — a restriction that read as enforced
 * everywhere anyone looked, and lapsed in the one place nobody did. Both sites
 * were individually green, which is exactly why no existing test caught it.
 *
 * CLI deny flags do NOT persist across a `--resume`, so this is not a
 * belt-and-braces re-arm: it is the ONLY thing standing between a resumed
 * autonomous agent and its full native toolset. A missing flag here is not a
 * degraded restriction, it is an absent one.
 *
 * ## The property under test
 *
 * The expectation is DERIVED FROM THE POLICY, never hand-listed: every flag
 * `capabilityPolicyFlags({ client:'claude', surface:'wake' })` emits must appear
 * as an exact token in the argv `resumeCommandFor` returns. A restriction added
 * to the policy and not consumed here fails on the day it is added.
 *
 * Unlike the launch-surface sibling this asserts a returned command rather than
 * a spawned process's argv — `resumeCommandFor` is the real, exported seam the
 * executor spawns from, and driving it needs no live claude session. What makes
 * it integration rather than unit is that it crosses the workspace boundary and
 * measures the CONSUMER (operator-core) against the PRODUCER
 * (@papercusp/orchestrator) — the axis the drift ran along.
 */
import { describe, expect, it } from 'vitest';
import { capabilityPolicyFlags } from '@papercusp/orchestrator/managed-capability-policy';
import { resumeCommandFor } from './wake-executor';

const WAKE_TEXT = 'wake-positional-sentinel';

function claudeResumeArgs(): string[] {
  const cmd = resumeCommandFor(
    { agent: 'claude', sessionId: 'sess-integration-fixture', ompThreadId: null },
    WAKE_TEXT,
  );
  expect(cmd, 'resumeCommandFor returned null for a well-formed claude handle').not.toBeNull();
  expect(cmd!.bin).toBe('claude');
  return cmd!.args;
}

describe('wake executor — capability policy reaches the resumed argv', () => {
  it('carries EVERY policy flag the wake surface resolves', () => {
    const expected = capabilityPolicyFlags({ client: 'claude', surface: 'wake' });

    // CALIBRATION — without this the subset assertion is vacuous: an empty
    // policy would satisfy it by asserting nothing. That false-green is the
    // single most dangerous outcome for this file, because "wake re-arms the
    // restrictions" would keep reading as proven while nothing was checked.
    expect(
      expected.length,
      'capabilityPolicyFlags emitted too few flags for the wake surface — the assertion ' +
        'below would be vacuous. Either the policy regressed, or a deliberate policy ' +
        'change needs this calibration updated with it.',
    ).toBeGreaterThanOrEqual(2);

    const args = claudeResumeArgs();
    const missing = expected.filter((flag) => !args.includes(flag));
    expect(
      missing,
      `the wake call site dropped ${missing.length} policy flag(s). A resumed agent would ` +
        'regain exactly these native capabilities. This is the P-005 drift class, at the ' +
        `very site it originally occurred.\nACTUAL ARGV: ${JSON.stringify(args)}`,
    ).toEqual([]);
  });

  it('keeps the wake prompt as the final positional, unswallowed by a variadic flag', () => {
    // D-002: `--disallowedTools A B C` is variadic and would consume the
    // positional wake text, so the turn would resume with no prompt. Every
    // policy flag must therefore be a single `=` token AND the prompt must
    // survive as the last argument.
    const args = claudeResumeArgs();
    expect(args[args.length - 1]).toBe(WAKE_TEXT);

    for (const flag of capabilityPolicyFlags({ client: 'claude', surface: 'wake' })) {
      if (!flag.startsWith('--')) continue;
      expect(flag, `policy emitted a variadic-shaped flag (${flag}) — it would eat the prompt`)
        .toContain('=');
      expect(args, `flag ${flag} is not present as a single token (it may have been split)`)
        .toContain(flag);
    }
  });

  it('re-arms the wake surface rather than relying on launch-time flags persisting', () => {
    // The mechanism note that makes the two tests above load-bearing: deny flags
    // are process-scoped CLI arguments, so a resume that omitted them would be
    // unrestricted regardless of how the original session was launched. Assert
    // the resume command is genuinely a fresh `--resume` invocation carrying its
    // own restrictions, not an attach to an existing restricted process.
    const args = claudeResumeArgs();
    expect(args).toContain('--resume');
    const policyFlags = capabilityPolicyFlags({ client: 'claude', surface: 'wake' });
    expect(policyFlags.length).toBeGreaterThanOrEqual(2);
    expect(args.some((a) => policyFlags.includes(a))).toBe(true);
  });
});
