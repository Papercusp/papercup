/**
 * governor.test.ts — the prompt-ablation D-004 gate (FB-09 / P-023).
 * Hermetic via GovernorGlueDeps fakes (the registrants.ts seam); the
 * preflight's own refusal matrix is FB-01's suite — this pins the glue:
 * self-registration fires ONLY on 'unregistered', stays unbudgeted, and the
 * verdict passes through unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';

import type { GovernorGlueDeps } from '../learning-governor/registrants';
import type { RegisterLearningLoopInput } from '../learning-governor/store';
import { PROMPT_ABLATION_LOOP_ID, promptAblationGovernorGate, promptAblationRegistrationInput } from './governor';

function deps(opts: {
  enabled?: boolean;
  verdict: { allow: boolean; reason?: string; remainingUsd: number | null };
}): { glue: GovernorGlueDeps; registered: RegisterLearningLoopInput[] } {
  const registered: RegisterLearningLoopInput[] = [];
  const glue: GovernorGlueDeps = {
    enabled: async () => opts.enabled ?? true,
    getSql: async () => ({}) as Sql,
    check: async () => opts.verdict as never,
    register: async (_sql, input) => {
      registered.push(input as RegisterLearningLoopInput);
      return {};
    },
    log: () => {},
  };
  return { glue, registered };
}

describe('promptAblationGovernorGate', () => {
  it("self-registers UNBUDGETED on 'unregistered' and still refuses this round", async () => {
    const { glue, registered } = deps({ verdict: { allow: false, reason: 'unregistered', remainingUsd: null } });
    const verdict = await promptAblationGovernorGate('w1', glue);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('unregistered');
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      workspaceId: 'w1',
      loopId: PROMPT_ABLATION_LOOP_ID,
      budgetKind: 'per-cycle',
      enforcement: 'governor',
    });
    // budget deliberately OMITTED — the owner's P-001 arming act sets it
    expect('budgetUsd' in registered[0]!).toBe(false);
  });

  it('never re-registers on any other verdict (an owner-set budget is never re-written)', async () => {
    for (const verdict of [
      { allow: false, reason: 'unbudgeted', remainingUsd: null },
      { allow: false, reason: 'governor-dark', remainingUsd: null },
      { allow: true, remainingUsd: 12 },
    ]) {
      const { glue, registered } = deps({ verdict: verdict as never });
      const out = await promptAblationGovernorGate('w1', glue);
      expect(out).toEqual(verdict);
      expect(registered).toHaveLength(0);
    }
  });

  it('a failing registration is swallowed (the refusing verdict already protects)', async () => {
    const { glue } = deps({ verdict: { allow: false, reason: 'unregistered', remainingUsd: null } });
    glue.register = async () => {
      throw new Error('pg down');
    };
    const verdict = await promptAblationGovernorGate('w1', glue);
    expect(verdict.reason).toBe('unregistered');
  });

  it('registration input is the stable loop identity', () => {
    expect(promptAblationRegistrationInput('w9')).toEqual({
      workspaceId: 'w9',
      loopId: 'prompt-ablation',
      displayName: 'Prompt sedimentology (weekly shadow ablation)',
      budgetKind: 'per-cycle',
      enforcement: 'governor',
    });
  });
});
