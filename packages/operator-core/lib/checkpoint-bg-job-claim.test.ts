import { describe, it, expect } from 'vitest';
import { detectBgJobCheckpointClaim } from './checkpoint-bg-job-claim';

describe('detectBgJobCheckpointClaim (EI-18654296679612119 — unverifiable bg-job checkpoint claim)', () => {
  it('flags the live repro shape: "in bg job <id> (log <path>) ... will complete once both are clean"', () => {
    const r = detectBgJobCheckpointClaim(
      'Verifying: (1) apps/operator tsc --noEmit in bg job bieg6308m (log /tmp/wi5778-tsc-operator.log), ' +
        '(2) npm run test:affected in bg job bix2da57w (log /tmp/wi5778-affected.log). Will complete once both are clean.',
    );
    expect(r.detected).toBe(true);
    expect(r.reason).toMatch(/ps -p <pid>/);
    expect(r.reason).toMatch(/EI-16611/);
    expect(r.reason).toMatch(/completion marker/);
  });

  it('flags "background task"/"background verification" phrasing', () => {
    expect(detectBgJobCheckpointClaim('background verification jobs in flight, will complete once clean').detected).toBe(
      true,
    );
    expect(detectBgJobCheckpointClaim('kicked off a background task to run the suite').detected).toBe(true);
  });

  it('flags a literal run_in_background reference', () => {
    expect(
      detectBgJobCheckpointClaim('launched via Bash run_in_background: true, task id bfdsrowp3').detected,
    ).toBe(true);
  });

  it('flags "in-flight job/task" phrasing (hyphenated, spaced, or closed; singular or plural)', () => {
    expect(detectBgJobCheckpointClaim('one inflight task remains').detected).toBe(true);
    expect(detectBgJobCheckpointClaim('one in-flight job remains').detected).toBe(true);
    expect(detectBgJobCheckpointClaim('two in flight jobs remain').detected).toBe(true);
  });

  it('does NOT flag an ordinary checkpoint with no background-job claim', () => {
    const r = detectBgJobCheckpointClaim(
      'Read the bug body, not yet started. Next: open the two hinted files and find the right seam.',
    );
    expect(r.detected).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('does NOT flag when a job/task is mentioned but not as a background reference', () => {
    // "task" alone (e.g. referring to the work-item itself) must not false-positive.
    expect(detectBgJobCheckpointClaim('this task is about the checkpoint tooling').detected).toBe(false);
    expect(detectBgJobCheckpointClaim('filed a follow-up job in the queue').detected).toBe(false);
  });

  it('is null/blank-safe', () => {
    expect(detectBgJobCheckpointClaim(null)).toEqual({ detected: false });
    expect(detectBgJobCheckpointClaim(undefined)).toEqual({ detected: false });
    expect(detectBgJobCheckpointClaim('   ')).toEqual({ detected: false });
    expect(detectBgJobCheckpointClaim('')).toEqual({ detected: false });
  });
});
