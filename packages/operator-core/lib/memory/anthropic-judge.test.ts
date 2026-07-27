import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAnthropicJudge,
  conflictJudgeAvailable,
  warnConflictJudgeUnavailableOnce,
  resetConflictJudgeWarnForTest,
  warnKnowledgePackJudgeUnavailableOnce,
  resetKnowledgePackJudgeWarnForTest,
} from './anthropic-judge';

const origEnv = { ...process.env };
beforeEach(() => { process.env = { ...origEnv }; });
afterEach(() => { process.env = origEnv; });

describe('createAnthropicJudge', () => {
  it('returns a no-op judge when no API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const judge = createAnthropicJudge();
    const r = await judge({
      newText: 'foo',
      neighbors: [{ id: 'n1', text: 'bar' }],
    });
    expect(r).toEqual({ conflicts: [] });
  });

  it('no-op judge when explicit empty apiKey passed', async () => {
    const judge = createAnthropicJudge({ apiKey: '' });
    const r = await judge({
      newText: 'foo',
      neighbors: [{ id: 'n1', text: 'bar' }],
    });
    expect(r).toEqual({ conflicts: [] });
  });

  // We can't unit-test the live LLM call without mocking the dynamic
  // import. The real path is exercised via:
  //   1. checkConflicts() integration test (mocked judge)
  //   2. manual smoke when ANTHROPIC_API_KEY is set
  // What we CAN unit-test: that an injected judge with the right
  // signature is callable + returns the expected shape.
  it('returns a callable judge when apiKey is set (smoke)', () => {
    const judge = createAnthropicJudge({ apiKey: 'sk-ant-test' });
    expect(typeof judge).toBe('function');
  });
});

describe('conflictJudgeAvailable', () => {
  it('false when no key resolves (env absent, no override)', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(conflictJudgeAvailable()).toBe(false);
  });

  it('true when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(conflictJudgeAvailable()).toBe(true);
  });

  it('an explicit empty override still reads false even with env set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(conflictJudgeAvailable({ apiKey: '' })).toBe(false);
  });
});

// EI-18746586784230719 — the detector-failure half: a default-ON contradiction
// guard that silently no-ops when unkeyed must say so, at least once, rather
// than looking byte-identical to a healthy "no conflicts found". These pin the
// LATCH behaviour (call-count), not the console line itself (guarded off under
// NODE_ENV==='test' — see b1-timeout.test.ts's note on the same pattern).
describe('warnConflictJudgeUnavailableOnce (memory:remember)', () => {
  beforeEach(() => resetConflictJudgeWarnForTest());
  afterEach(() => resetConflictJudgeWarnForTest());

  it('is idempotent — safe to call repeatedly without throwing', () => {
    expect(() => {
      warnConflictJudgeUnavailableOnce();
      warnConflictJudgeUnavailableOnce();
      warnConflictJudgeUnavailableOnce();
    }).not.toThrow();
  });

  it('actually emits console.warn exactly once outside NODE_ENV=test', () => {
    const origEnvValue = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnConflictJudgeUnavailableOnce();
      warnConflictJudgeUnavailableOnce();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(/conflict-check is ENABLED/);
    } finally {
      spy.mockRestore();
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnvValue;
    }
  });
});

describe('warnKnowledgePackJudgeUnavailableOnce (knowledge-packs)', () => {
  beforeEach(() => resetKnowledgePackJudgeWarnForTest());
  afterEach(() => resetKnowledgePackJudgeWarnForTest());

  it('is idempotent — safe to call repeatedly without throwing', () => {
    expect(() => {
      warnKnowledgePackJudgeUnavailableOnce();
      warnKnowledgePackJudgeUnavailableOnce();
    }).not.toThrow();
  });

  it('actually emits console.warn exactly once outside NODE_ENV=test', () => {
    const origEnvValue = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnKnowledgePackJudgeUnavailableOnce();
      warnKnowledgePackJudgeUnavailableOnce();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(/knowledge-packs/);
    } finally {
      spy.mockRestore();
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnvValue;
    }
  });

  it('is a SEPARATE latch from the memory:remember warn (both fire independently)', () => {
    const origEnvValue = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resetConflictJudgeWarnForTest();
      warnConflictJudgeUnavailableOnce();
      warnKnowledgePackJudgeUnavailableOnce();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnvValue;
      resetConflictJudgeWarnForTest();
    }
  });
});
