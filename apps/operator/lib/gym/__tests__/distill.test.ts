import { describe, it, expect } from 'vitest';
import { distillTrace, type RawTrace } from '../distill';

/**
 * Trace distillation (P-029, ③b/D-017): select + budget a multi-hour multi-agent
 * run into a judge-sized input. The diff is primary (the judge must see the produced
 * code); per-role transcripts are truncated; the whole thing respects a hard char
 * budget. Deterministic — the distillation is itself a noise source, so it must be
 * stable. (Real distillation-as-noise-source validation is at P-014.)
 */
const smallTrace: RawTrace = {
  diff: 'diff --git a/x b/x\n+ added a line',
  roleTranscripts: [
    { role: 'worker', runId: 'r1', text: 'I added the endpoint.' },
    { role: 'validator', runId: 'r2', text: 'PASS — endpoint returns 200.' },
  ],
  terminalState: 'passed',
  signals: { regressions: false, planted_bug_caught: null, cost_usd: 0.5 },
};

describe('distillTrace', () => {
  it('includes the diff, each role transcript, and the terminal state when everything fits', () => {
    const { text, truncated } = distillTrace(smallTrace, { maxChars: 10_000 });
    expect(truncated).toBe(false);
    expect(text).toContain('diff --git');
    expect(text).toContain('worker');
    expect(text).toContain('I added the endpoint.');
    expect(text).toContain('validator');
    expect(text).toContain('passed');
  });

  it('truncates a huge diff and flags truncation, staying within the budget', () => {
    const huge: RawTrace = { ...smallTrace, diff: 'x'.repeat(50_000) };
    const { text, truncated } = distillTrace(huge, { maxChars: 5_000, maxDiffChars: 2_000 });
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(5_000);
    expect(text).toMatch(/truncat/i);
  });

  it('truncates an over-long role transcript', () => {
    const huge: RawTrace = {
      ...smallTrace,
      roleTranscripts: [{ role: 'worker', runId: 'r1', text: 'y'.repeat(20_000) }],
    };
    const { truncated } = distillTrace(huge, { maxChars: 100_000, maxTranscriptCharsPerRole: 500 });
    expect(truncated).toBe(true);
  });

  it('always respects the hard maxChars budget', () => {
    const huge: RawTrace = {
      diff: 'd'.repeat(100_000),
      roleTranscripts: Array.from({ length: 20 }, (_, i) => ({ role: `role${i}`, runId: `r${i}`, text: 'z'.repeat(10_000) })),
      terminalState: 'failed',
    };
    const { text } = distillTrace(huge, { maxChars: 8_000 });
    expect(text.length).toBeLessThanOrEqual(8_000);
  });

  it('is deterministic', () => {
    expect(distillTrace(smallTrace, { maxChars: 10_000 })).toEqual(distillTrace(smallTrace, { maxChars: 10_000 }));
  });
});
