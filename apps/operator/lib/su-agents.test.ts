import { describe, it, expect } from 'vitest';
import { SU_AGENTS, SU_WRAPPER_BIN, isSuAgent } from './su-agents';

describe('su-agents', () => {
  it('maps each agent to its installed *-su wrapper', () => {
    expect(SU_WRAPPER_BIN.claude).toBe('claude-su');
    expect(SU_WRAPPER_BIN.omp).toBe('omp-su');
    expect(SU_WRAPPER_BIN.codex).toBe('codex-su');
  });

  it('isSuAgent guards exactly the three kinds', () => {
    for (const a of SU_AGENTS) expect(isSuAgent(a)).toBe(true);
    expect(isSuAgent('gemini')).toBe(false);
    expect(isSuAgent(null)).toBe(false);
    expect(isSuAgent(undefined)).toBe(false);
  });
});
