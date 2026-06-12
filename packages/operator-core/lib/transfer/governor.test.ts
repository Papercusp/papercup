/**
 * governor.test.ts — the transfer loop's D-004 gate (P-022 / FB-08): verdict
 * passthrough + first-contact UNBUDGETED self-registration. Injected deps,
 * zero flags/PG IO (mirrors lib/negative-space/governor.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { GovernorVerdict } from '../learning-governor/core';
import { TRANSFER_LOOP_ID } from './types';
import { transferGovernorGate, transferRegistrationInput } from './governor';

const verdicts: Record<string, GovernorVerdict> = {
  allow: { allow: true, remainingUsd: 4.5 },
  unbudgeted: { allow: false, reason: 'unbudgeted', remainingUsd: null },
  unregistered: { allow: false, reason: 'unregistered', remainingUsd: null },
  dark: { allow: false, reason: 'governor-dark', remainingUsd: null },
};

function deps(verdict: GovernorVerdict) {
  const register = vi.fn(async () => ({}));
  return {
    register,
    enabled: async () => true,
    getSql: async () => ({}) as never,
    check: async () => verdict,
    log: () => {},
  };
}

describe('transferRegistrationInput', () => {
  it('registers a LIFETIME-budgeted governor-enforced loop with the budget OMITTED', () => {
    const input = transferRegistrationInput('ws-1');
    expect(input.loopId).toBe(TRANSFER_LOOP_ID);
    expect(input.budgetKind).toBe('lifetime');
    expect(input.enforcement).toBe('governor');
    expect('budgetUsd' in input).toBe(false); // omitted ⇒ inserts unbudgeted, preserved thereafter
  });
});

describe('transferGovernorGate', () => {
  it('passes non-unregistered verdicts through without registering', async () => {
    for (const v of [verdicts.allow, verdicts.unbudgeted, verdicts.dark]) {
      const d = deps(v);
      expect(await transferGovernorGate('ws-1', d)).toEqual(v);
      expect(d.register).not.toHaveBeenCalled();
    }
  });

  it('first contact self-registers UNBUDGETED and still refuses this round (the D-004 watch list)', async () => {
    const d = deps(verdicts.unregistered);
    const verdict = await transferGovernorGate('ws-1', d);
    expect(verdict).toEqual(verdicts.unregistered);
    expect(d.register).toHaveBeenCalledWith(expect.anything(), transferRegistrationInput('ws-1'));
  });

  it('a failed self-registration is best-effort (the verdict already refuses)', async () => {
    const d = deps(verdicts.unregistered);
    d.register.mockRejectedValue(new Error('pg down'));
    await expect(transferGovernorGate('ws-1', d)).resolves.toEqual(verdicts.unregistered);
  });
});
