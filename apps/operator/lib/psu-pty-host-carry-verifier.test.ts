// @vitest-environment node
/**
 * Focused verifier contract for the truthful cold-RECYCLE acceptance rubric.
 *
 * Keep this file deliberately narrow: scorecards:emit executes every test in
 * each check.files entry, so the rubric must not point at the broad host-unit
 * suite when it needs the submit-verifier and failure-mapping cases.
 */
import { describe, expect, it } from 'vitest';
import { makeSubmitVerifier, submitExhaustionTerminatesHost, submitVerificationFailureReason } from '../scripts/psu-pty-host.mjs';

function rig({
  output,
  input,
  quotaBlocked,
  pollMs = 100,
  polls = 4,
  maxResubmits = 3,
  quietMs = 50,
}: {
  output: (time: number) => number;
  input?: (time: number) => number;
  quotaBlocked?: (time: number) => boolean;
  pollMs?: number;
  polls?: number;
  maxResubmits?: number;
  quietMs?: number;
}) {
  let time = 0;
  const crs: number[] = [];
  const exhausted: Array<{ polls: number; resubmits: number; outputObservedAfterResubmit: boolean }> = [];
  const verifier = makeSubmitVerifier({
    lastOutputAt: () => output(time),
    lastInputAt: input ? () => input(time) : undefined,
    isQuotaBlocked: quotaBlocked ? () => quotaBlocked(time) : undefined,
    writeCr: () => crs.push(time),
    quietMs,
    pollMs,
    polls,
    maxResubmits,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    onResubmit: () => {},
    onExhausted: (details) => exhausted.push(details),
  });
  return { verifier, crs, exhausted };
}

describe('cold-RECYCLE submit verifier contract', () => {
  it('accepts a submitted turn with output and sends no resubmit CR', async () => {
    const { verifier, crs } = rig({ output: (time) => time });
    await expect(verifier.verify()).resolves.toEqual({
      polls: 4,
      resubmits: 0,
      aborted: null,
      exhausted: false,
    });
    expect(crs).toEqual([]);
  });

  it('bounds quiet recovery and reports exhaustion after the final retry', async () => {
    const { verifier, crs, exhausted } = rig({ output: () => 0, polls: 4, maxResubmits: 2 });
    const result = await verifier.verify();
    expect(result).toMatchObject({ exhausted: true, aborted: null, resubmits: 2 });
    expect(crs).toEqual([100, 200]);
    expect(exhausted).toEqual([{ polls: 2, resubmits: 2, outputObservedAfterResubmit: false }]);
  });

  it('stops retrying when output starts after one resubmit', async () => {
    const { verifier, crs, exhausted } = rig({ output: (time) => (time >= 150 ? time : 0) });
    await expect(verifier.verify()).resolves.toMatchObject({ resubmits: 1, exhausted: false, aborted: null });
    expect(crs).toEqual([100]);
    expect(exhausted).toEqual([]);
  });

  it('aborts on human input and never fights the staged line', async () => {
    const { verifier, crs } = rig({ output: () => 0, input: (time) => (time >= 150 ? time : 0), polls: 6 });
    await expect(verifier.verify()).resolves.toMatchObject({ aborted: 'human-input' });
    expect(crs).toEqual([100]);
  });

  it('distinguishes a quota wall from exhaustion without fatal retry callbacks', async () => {
    const { verifier, crs, exhausted } = rig({ output: () => 0, quotaBlocked: () => true });
    await expect(verifier.verify()).resolves.toMatchObject({ aborted: 'quota-blocked', resubmits: 0 });
    expect(crs).toEqual([]);
    expect(exhausted).toEqual([]);
  });

  it('maps non-success verifier results to stable delivery reasons', () => {
    expect(submitVerificationFailureReason({ exhausted: true, aborted: null })).toBe('submit-verification-exhausted');
    expect(submitVerificationFailureReason({ exhausted: false, aborted: 'human-input' })).toBe(
      'submit-verification-aborted-human-input',
    );
    expect(submitVerificationFailureReason({ exhausted: false, aborted: null })).toBeNull();
  });

  it('keeps wake exhaustion non-fatal while startup exhaustion remains fatal', () => {
    expect(submitExhaustionTerminatesHost('turn inject')).toBe(false);
    expect(submitExhaustionTerminatesHost('reset inject')).toBe(false);
    expect(submitExhaustionTerminatesHost('launch kickoff')).toBe(true);
    expect(submitExhaustionTerminatesHost('recycle carry-note')).toBe(true);
    expect(submitExhaustionTerminatesHost(undefined)).toBe(true);
  });
});
