import { describe, expect, it } from 'vitest';
import { detectProsePickOne } from './operator-prose-pick-one';

describe('detectProsePickOne (WI-4950 class)', () => {
  it('detects the live repro from operator_turns seq 11822 (2026-07-16)', () => {
    const hit = detectProsePickOne(
      "Three picks: unstick the placement stall, dig into the release-readiness rubric that's overdue, or triage the aging escalation backlog. Which?",
    );
    expect(hit.detected).toBe(true);
  });

  it('detects the original WI-4950 repro from seq 11402 (2026-07-15)', () => {
    const hit = detectProsePickOne(
      'Three picks: the security disclosure needing password rotation, the mobile release blockers, or the placement stall on papercup. Which?',
    );
    expect(hit.detected).toBe(true);
  });

  it("detects the owner's original reported symptom shape wrapped in <say> tags", () => {
    const hit = detectProsePickOne(
      '<say>A few things need you. You could rotate the leaked password, unblock the mobile release, or look at the placement stall. Pick one?</say>',
    );
    expect(hit.detected).toBe(true);
  });

  it('detects a numbered-list enumeration ending on a pick-question', () => {
    const hit = detectProsePickOne(
      'Here are your options: 1. restart the service 2. roll back the deploy. Which one do you want?',
    );
    expect(hit.detected).toBe(true);
    expect(hit.reason).toBe('numbered-list+pick-question');
  });

  it('detects a bulleted enumeration ending on a pick-question', () => {
    const hit = detectProsePickOne(
      'Two ways forward:\n- ship the hotfix now\n- wait for the nightly gate\nYour call?',
    );
    expect(hit.detected).toBe(true);
  });

  it('does NOT flag a plain informational reply', () => {
    expect(detectProsePickOne('Got it — WI-5032 ping received.').detected).toBe(false);
  });

  it('does NOT flag a single-suggestion trailing question (normal conversational move)', () => {
    expect(
      detectProsePickOne('Forms has an escalation flagged 14 minutes ago. Take a look?').detected,
    ).toBe(false);
  });

  it('does NOT flag an informational sentence containing "or" without a pick-question', () => {
    expect(
      detectProsePickOne(
        'You can deploy with the CLI, or wait for the pipeline to promote it automatically.',
      ).detected,
    ).toBe(false);
  });

  it('does NOT flag an open-ended question', () => {
    expect(
      detectProsePickOne('What would make this feel done for you?').detected,
    ).toBe(false);
  });

  it('does NOT flag empty / tag-only turns', () => {
    expect(detectProsePickOne('').detected).toBe(false);
    expect(detectProsePickOne('<continue/>').detected).toBe(false);
  });
});
