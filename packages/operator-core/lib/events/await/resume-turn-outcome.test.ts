import { describe, it, expect } from 'vitest';
import { classifyResumeTurnExit, isRateLimitDeath, type ResumeTurnExitRaw } from './resume-turn-outcome';

const raw = (p: Partial<ResumeTurnExitRaw>): ResumeTurnExitRaw => ({
  exitCode: 0,
  signal: null,
  stdoutTail: '',
  stderrTail: '',
  ...p,
});

describe('classifyResumeTurnExit — survived vs died (P0a)', () => {
  it('a clean exit (code 0, no signal) is SUCCESS even with an empty output tail', () => {
    // The crux: a clean `claude --resume … -p` exit must NOT be misread as empty_output
    // just because we captured only a bounded tail (not the transcript).
    const out = classifyResumeTurnExit(raw({ exitCode: 0, stdoutTail: '' }));
    expect(out.ok).toBe(true);
  });

  it('a clean exit is success even if the tail merely MENTIONS a rate limit', () => {
    // A successful turn whose output happens to contain the words "rate limit" must
    // not be classified a death (the failed-exit gate in turn-error guards this too).
    const out = classifyResumeTurnExit(raw({ exitCode: 0, stdoutTail: 'discussed the rate limit fix' }));
    expect(out.ok).toBe(true);
  });

  it('classifies the canonical loop-death: exitCode=1 with a 429 on STDOUT as rate_limited', () => {
    // The exact storm signature from the insight doc: "the agent produced no turn
    // (exitCode=1)" because its first model call 429'd. The CLI prints the API error
    // to STDOUT, so the classifier must fold stdout in on a failed exit.
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stdoutTail: 'API Error: 429 Too Many Requests · Rate limited', stderrTail: '' }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('rate_limited');
      expect(isRateLimitDeath(out)).toBe(true);
    }
  });

  it('classifies a subscription usage-cap death (usage_limit) and parses its reset', () => {
    const now = Date.UTC(2026, 5, 23, 10, 0, 0);
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stdoutTail: "You've hit your usage limit · resets 4:20am" }),
      now,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('usage_limit');
      expect(isRateLimitDeath(out)).toBe(true);
      expect(out.error.resetAt).toBeGreaterThan(now);
    }
  });

  it('the transient-overload phrase ("temporarily limiting … not your usage limit") is rate_limited, not usage_limit', () => {
    const out = classifyResumeTurnExit(
      raw({ exitCode: 1, stdoutTail: 'Server is temporarily limiting requests (not your usage limit) · Rate limited' }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.class).toBe('rate_limited');
  });

  it('a generic non-zero exit with no API error is a crash (death, but not a rate-limit)', () => {
    const out = classifyResumeTurnExit(raw({ exitCode: 1, stderrTail: 'TypeError: boom' }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.class).toBe('agent_crash');
      expect(isRateLimitDeath(out)).toBe(false);
    }
  });

  it('a signal kill is a death', () => {
    const out = classifyResumeTurnExit(raw({ exitCode: null, signal: 'SIGKILL' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(isRateLimitDeath(out)).toBe(false);
  });

  it('a null/null exit (post-pid spawn error) is treated as a death, not a survival', () => {
    const out = classifyResumeTurnExit(raw({ exitCode: null, signal: null }));
    expect(out.ok).toBe(false);
  });

  it('isRateLimitDeath is false for a survived turn', () => {
    expect(isRateLimitDeath(classifyResumeTurnExit(raw({ exitCode: 0 })))).toBe(false);
  });
});
