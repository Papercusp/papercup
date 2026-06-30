import { describe, it, expect } from 'vitest';
import { SU_AGENTS, isSuAgent, SU_CONTEXT_SIZES, isSuContextSize } from './su-agents';

describe('su-agents', () => {
  it('lists exactly the three superuser agents', () => {
    expect(SU_AGENTS).toEqual(['claude', 'omp', 'codex']);
  });

  it('isSuAgent guards exactly the three kinds', () => {
    for (const a of SU_AGENTS) expect(isSuAgent(a)).toBe(true);
    expect(isSuAgent('gemini')).toBe(false);
    expect(isSuAgent(null)).toBe(false);
    expect(isSuAgent(undefined)).toBe(false);
  });
});

// su-context-size-variants (WI-1282): the initial-context SIZE a launched SU
// session boots with, orthogonal to the agent.
describe('su-context-size guards', () => {
  it('lists exactly the two context sizes', () => {
    expect(SU_CONTEXT_SIZES).toEqual(['full', 'trimmed']);
  });

  it('isSuContextSize accepts the two valid sizes', () => {
    for (const s of SU_CONTEXT_SIZES) expect(isSuContextSize(s)).toBe(true);
  });

  it('isSuContextSize rejects typos / non-string / empty / nullish', () => {
    // A near-miss typo must 400 upstream (launch-su), not silently pass.
    expect(isSuContextSize('trimed')).toBe(false);
    expect(isSuContextSize('FULL')).toBe(false);
    expect(isSuContextSize('default')).toBe(false);
    expect(isSuContextSize('')).toBe(false);
    expect(isSuContextSize(null)).toBe(false);
    expect(isSuContextSize(undefined)).toBe(false);
    expect(isSuContextSize(0)).toBe(false);
    expect(isSuContextSize({})).toBe(false);
  });
});
