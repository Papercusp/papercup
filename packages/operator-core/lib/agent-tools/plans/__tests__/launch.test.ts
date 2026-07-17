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
import { kickoffGuardProfileForAgent } from '../launch-prompt';

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

  // kickoff-prompt-absorption-2026-07-17 P-004: the lean profile — the guard
  // clauses whose behaviors became structural (P-002 orient fold, P-003a eval
  // referral, P-003b plans-read hook) drop out; the irreducible delta (plan
  // binding + orient pointer + completion integrity / routing gate) stays.
  describe('lean guard profile (P-004)', () => {
    it('lean AUTO kickoff keeps the binding + orient pointer + completion integrity, drops the absorbed guards', () => {
      const text = deriveLaunchPromptText(null, true, { slug: 'my-plan', harness: 'papercusp' }, 'lean');
      // Irreducible delta stays:
      expect(text).toContain('advance the plan `my-plan`');
      expect(text).toContain('coord:orient');
      expect(text).toContain('planSlug: "my-plan"');
      expect(text).toContain('`## Now`');
      expect(text).toContain('mark an item done ONLY after'); // EI-7000 — no absorber, kept
      // Absorbed clauses gone:
      expect(text).not.toContain('plans:get'); // → P-002 orient fold (WI-5228)
      expect(text).not.toContain('NOT on disk'); // → P-003b plans-read hook (WI-5229)
      expect(text).not.toContain('eval'); // → P-003a unknown-tool referral (EI-9011)
    });

    it('lean routing-gate kickoff keeps the gate + fleet:launch-on-plan verb, drops the absorbed guards', () => {
      const text = deriveLaunchPromptText(null, false, { slug: 'my-plan', harness: 'papercusp' }, 'lean');
      expect(text).toContain('handed the plan `my-plan`');
      expect(text).toContain('coord:orient');
      expect(text).toContain('routing gate');
      expect(text).toContain('fleet:launch-on-plan'); // behavior clause, no absorber — kept
      expect(text).toContain('{ slug: "my-plan", harness: "papercusp" }'); // plans:get full-body pointer kept
      expect(text).not.toContain('do NOT use the `read`');
      expect(text).not.toContain('eval');
      expect(text).not.toContain('lsp');
    });

    it('lean without a plan binding falls back to the full guard text (no orient target to point at)', () => {
      const auto = deriveLaunchPromptText(null, true, null, 'lean');
      expect(auto).toContain('advance this plan');
      expect(auto).toContain('NOT hunt for a plan file');
      const gated = deriveLaunchPromptText(null, false, null, 'lean');
      expect(gated).toContain('handed a plan to implement');
      expect(gated).toContain('routing gate');
    });

    it('a custom note is profile-independent (verbatim + plan pointer either way)', () => {
      expect(deriveLaunchPromptText('do X', true, { slug: 'p' }, 'lean')).toBe(
        deriveLaunchPromptText('do X', true, { slug: 'p' }, 'full'),
      );
    });

    it('the default profile is full — existing callers are byte-identical', () => {
      expect(deriveLaunchPromptText(null, true, { slug: 'p', harness: 'h' })).toBe(
        deriveLaunchPromptText(null, true, { slug: 'p', harness: 'h' }, 'full'),
      );
    });
  });
});

describe('kickoffGuardProfileForAgent (P-004)', () => {
  it("is 'lean' ONLY for claude — the backend whose hook layer carries the P-003b guard", () => {
    expect(kickoffGuardProfileForAgent('claude')).toBe('lean');
  });

  it("keeps every other backend on 'full' (omp = the ornith/local weak-model family; codex runs no papercusp hooks)", () => {
    for (const agent of ['omp', 'codex', 'ornith', '', null, undefined]) {
      expect(kickoffGuardProfileForAgent(agent)).toBe('full');
    }
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
