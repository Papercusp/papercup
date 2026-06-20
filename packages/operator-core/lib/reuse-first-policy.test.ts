/**
 * reuse-first-policy.test.ts — renderReuseFirstNudge injects the shared soft
 * "extend, don't fork" clause into the operator-launched-role prompt base. It
 * returns the SAME REUSE_FIRST_NUDGE string the spawned-bee base emits, so the
 * two bases can't desync (agents-reuse-first-default-2026-06-20 P-001/D-001).
 */
import { describe, expect, it } from 'vitest';
import { REUSE_FIRST_NUDGE } from '@papercusp/orchestrator/role-prompt';
import { renderReuseFirstNudge } from './reuse-first-policy';

describe('renderReuseFirstNudge', () => {
  it('returns the one shared REUSE_FIRST_NUDGE constant (no desync from the spawned-bee base)', () => {
    expect(renderReuseFirstNudge()).toBe(REUSE_FIRST_NUDGE);
  });

  it('the clause names the trigger + the soft ask + the review smell', () => {
    const nudge = renderReuseFirstNudge();
    expect(nudge).toMatch(/## Reuse-first \(extend, don't fork\)/);
    expect(nudge).toMatch(/new durable surface/);
    expect(nudge).toMatch(/smallest extension/);
    expect(nudge).toMatch(/briefly note what you reused/);
    expect(nudge).toMatch(/top review smell/);
  });
});
