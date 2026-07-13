/**
 * WI-4494 — the run records its own verdict.
 *
 * The bug these pin: `gate_health` was written ONLY by the routine that parsed the CLI's stdout, so
 * a DETACHED manual run (`release:checkpoint-run`) ran the full suite, produced a real green/red,
 * and threw it away — while HOLDING the run-lock that made the hourly routine fire record
 * `skipped-locked` (a no-op). The gate could then not produce a verdict at all while manual runs
 * were in flight. Live on 2026-07-12: three consecutive fires skipped, the release pin frozen ~10h,
 * and the WI-4486 memory-blackout fix unable to ship on a green pin.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/gate-verdict-target.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  gateVerdictTargetFromEnv,
  gateVerdictEnv,
  isRecordableVerdict,
  GATE_VERDICT_WORKSPACE_ENV,
  GATE_VERDICT_HARNESS_ENV,
} from './gate-verdict-target';

describe('isRecordableVerdict — what counts as a statement about the gate', () => {
  it('⭐ a lock collision is NOT a verdict — this is the whole fix', () => {
    // The run that HOLDS the lock is producing the real verdict and (post-WI-4494) records it
    // itself. If a `skipped-locked` were recordable, the colliding run would overwrite the real
    // verdict with a non-observation — the mirror image of the bug.
    expect(isRecordableVerdict('skipped-locked')).toBe(false);
    expect(isRecordableVerdict('skipped-disabled')).toBe(false);
    expect(isRecordableVerdict('skipped-no-tooling')).toBe(false);
  });

  it('⭐ every real verdict IS recordable — including the reds, which are what misdirect', () => {
    for (const reason of [
      'advanced',
      'advanced-prefix',
      'up-to-date',
      'not-green',
      'not-fast-forward',
      'create-failed',
      'perf-held',
      'delta-held',
      'error',
    ]) {
      expect(isRecordableVerdict(reason), reason).toBe(true);
    }
  });

  it('an absent reason is not a verdict', () => {
    expect(isRecordableVerdict(undefined)).toBe(false);
    expect(isRecordableVerdict(null)).toBe(false);
    expect(isRecordableVerdict('')).toBe(false);
  });
});

describe('gateVerdictTargetFromEnv — who authorizes a run to record', () => {
  it('resolves the target the launcher stamped', () => {
    expect(
      gateVerdictTargetFromEnv({
        [GATE_VERDICT_WORKSPACE_ENV]: 'papercusp-workspace',
        [GATE_VERDICT_HARNESS_ENV]: 'papercusp',
      }),
    ).toEqual({ workspaceId: 'papercusp-workspace', installSlug: 'papercusp' });
  });

  it('⭐ no stamp ⇒ no target ⇒ the run does NOT record — the version-skew safety valve', () => {
    // The DEPLOYED routine drives the INTEGRATION tree's CLI, so an old routine (which does not
    // stamp the env) routinely runs this new CLI. It must fall back to exactly the old behaviour —
    // the caller records — rather than recording against a guessed harness. The worst case of this
    // whole change is therefore "pre-WI-4494 behaviour", never a blind gate.
    expect(gateVerdictTargetFromEnv({})).toBeNull();
  });

  it('⭐ fails CLOSED on a half-stamp — a blank harness would UPDATE ... WHERE install_slug = \'\'', () => {
    // …which matches no row: a write that looks like it worked and changes nothing. That silent
    // no-op is the exact class of bug this work item exists to eliminate; do not reintroduce it.
    expect(gateVerdictTargetFromEnv({ [GATE_VERDICT_WORKSPACE_ENV]: 'papercusp-workspace' })).toBeNull();
    expect(gateVerdictTargetFromEnv({ [GATE_VERDICT_HARNESS_ENV]: 'papercusp' })).toBeNull();
    expect(
      gateVerdictTargetFromEnv({
        [GATE_VERDICT_WORKSPACE_ENV]: '   ',
        [GATE_VERDICT_HARNESS_ENV]: 'papercusp',
      }),
    ).toBeNull();
  });

  it('round-trips through the env a launcher stamps', () => {
    const target = { workspaceId: 'ws-1', installSlug: 'papercusp' };
    expect(gateVerdictTargetFromEnv(gateVerdictEnv(target))).toEqual(target);
  });
});
