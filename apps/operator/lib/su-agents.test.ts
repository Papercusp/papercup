import { describe, it, expect } from 'vitest';
import { SU_AGENTS, isSuAgent } from './su-agents';

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
