import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAnthropicJudge } from './anthropic-judge';

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
