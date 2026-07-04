/**
 * Unit coverage for the pure derivations in `plans:launch`
 * (plan-agent-launch-2026-05-21, P-012).
 *
 * `deriveLaunchPromptText` / `deriveLaunchTitle` are pure. The handler
 * itself is heavy IO (context bundle, plan_runs INSERT, agent spawn) —
 * exercised live in P-027 / P-028.
 */

import { describe, expect, it } from 'vitest';
import { deriveLaunchPromptText, deriveLaunchTitle } from '../launch';

describe('deriveLaunchPromptText', () => {
  it('uses the supplied note as the first user turn', () => {
    expect(deriveLaunchPromptText('fix the failing auth test')).toBe(
      'fix the failing auth test',
    );
  });

  it('trims surrounding whitespace from the note', () => {
    expect(deriveLaunchPromptText('  do the thing  ')).toBe('do the thing');
  });

  it('falls back to a default kickoff when the note is absent or blank', () => {
    for (const blank of [undefined, null, '', '   ', '\n\t']) {
      const text = deriveLaunchPromptText(blank);
      expect(text).toContain('advance this plan');
      expect(text).toContain('`## Now`');
    }
  });

  // Weak-model guard (ornith session 10115, 2026-07-03): the kickoff must carry the
  // literal plans:get args — an agent handed "the plan" with no slug parked on an
  // interactive `ask` asking which plan to read.
  it('bakes the exact plans:get args into the AUTO kickoff when a plan ref is supplied', () => {
    const text = deriveLaunchPromptText(null, true, { slug: 'my-plan', harness: 'papercusp' });
    expect(text).toContain('advance the plan `my-plan`');
    expect(text).toContain('{ slug: "my-plan", harness: "papercusp" }');
    expect(text).toContain('do NOT ask which plan');
    expect(text).toContain('`## Now`');
  });

  it('bakes the exact plans:get args into the routing-gate kickoff when a plan ref is supplied', () => {
    const text = deriveLaunchPromptText(null, false, { slug: 'my-plan', harness: 'papercusp' });
    expect(text).toContain('handed the plan `my-plan`');
    expect(text).toContain('{ slug: "my-plan", harness: "papercusp" }');
    expect(text).toContain('routing gate');
  });

  it('omits the harness arg when the plan ref has none', () => {
    const text = deriveLaunchPromptText(null, true, { slug: 'my-plan' });
    expect(text).toContain('{ slug: "my-plan" }');
  });

  it('appends the plan pointer to a custom note, and leaves a plan-less note verbatim', () => {
    const withPlan = deriveLaunchPromptText('fix the auth test', true, {
      slug: 'my-plan',
      harness: 'papercusp',
    });
    expect(withPlan.startsWith('fix the auth test')).toBe(true);
    expect(withPlan).toContain('{ slug: "my-plan", harness: "papercusp" }');
    expect(deriveLaunchPromptText('fix the auth test')).toBe('fix the auth test');
  });
});

describe('deriveLaunchTitle', () => {
  it('uses the first line of the note as the run title', () => {
    expect(deriveLaunchTitle('Wire up the runner\nplus details', 'Plan X')).toBe(
      'Wire up the runner',
    );
  });

  it('falls back to the plan title when the note is absent or blank', () => {
    expect(deriveLaunchTitle(undefined, 'Plan X')).toBe('Plan X');
    expect(deriveLaunchTitle('   ', 'Plan X')).toBe('Plan X');
  });

  it('truncates a long first line with an ellipsis', () => {
    const longNote = 'x'.repeat(200);
    const title = deriveLaunchTitle(longNote, 'Plan X');
    expect(title.length).toBe(118); // 117 chars + the ellipsis
    expect(title.endsWith('…')).toBe(true);
  });

  it('does not truncate a first line at or under 120 chars', () => {
    const note = 'y'.repeat(120);
    expect(deriveLaunchTitle(note, 'Plan X')).toBe(note);
  });
});
