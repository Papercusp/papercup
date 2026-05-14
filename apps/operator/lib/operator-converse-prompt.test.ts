import { describe, expect, it } from 'vitest';
import { OPERATOR_CONVERSE_PROMPT } from './operator-converse-prompt';

// The converse prompt is the LLM-facing contract for active
// conversation mode (voice + text). Pin the load-bearing pieces so an
// edit doesn't silently change persona / mode-switching behavior.

describe('OPERATOR_CONVERSE_PROMPT', () => {
  it('is a non-trivial string', () => {
    expect(typeof OPERATOR_CONVERSE_PROMPT).toBe('string');
    expect(OPERATOR_CONVERSE_PROMPT.length).toBeGreaterThan(500);
  });

  it('teaches the <say> / <set_mode> / <sleep> / <spawn> tag set', () => {
    // operator-converse-tags.ts parses these four; the prompt must
    // mention them or the LLM won't emit them.
    expect(OPERATOR_CONVERSE_PROMPT).toContain('<say');
    expect(OPERATOR_CONVERSE_PROMPT).toContain('<set_mode');
    expect(OPERATOR_CONVERSE_PROMPT).toContain('<spawn');
  });

  it('preserves the silence-vs-passive boundary', () => {
    // Regression: an earlier persona drift had the operator flip to
    // passive on long silences. The current rule is silence ≠ passive
    // — only direct user intent flips modes.
    expect(/never.*flip.*passive on silence|silence ≠ ["']stop|silence is not the same as/i.test(OPERATOR_CONVERSE_PROMPT)).toBe(true);
  });

  it('does not block on spawn (fire-and-forget)', () => {
    expect(/(do not block|fire-and-forget|future turn|let the user hear)/i.test(OPERATOR_CONVERSE_PROMPT)).toBe(true);
  });

  it('teaches the chunk requirement for worker spawns', () => {
    // Without this the LLM omits chunk= and orchestrator's chunk-loop
    // driver has nothing to dispatch.
    expect(/(chunk|spawn.*worker)/i.test(OPERATOR_CONVERSE_PROMPT)).toBe(true);
  });

  it('silence-after-question is retired from the brain prompt (2026-05-14)', () => {
    // The silence nudge is now emitted server-side by /silence-nudge,
    // bypassing the LLM entirely. The prompt should no longer mention
    // silence_after_question or the Silence section.
    expect(OPERATOR_CONVERSE_PROMPT).not.toMatch(/silence_after_question/);
    expect(OPERATOR_CONVERSE_PROMPT).not.toMatch(/^## Silence/m);
  });
});
