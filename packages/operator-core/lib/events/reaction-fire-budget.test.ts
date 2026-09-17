/**
 * The HOST half of the per-contributor fire budget (identities-v1 P-030 (c)):
 * the policy, the exemptions and the fail-open behaviour. The engine-layer
 * routing contract (including the load-bearing `mode:'durable'` case) lives in
 * `libs/generic/event-reaction/src/fire-budget.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FireBudgetRequest } from '@papercusp/event-reaction';
import {
  checkContributorFireBudget,
  CONTRIBUTOR_FIRE_BUDGET_WINDOW_MINUTES,
  DEFAULT_CONTRIBUTOR_FIRE_BUDGET,
} from './reaction-fire-budget';
import type { countRecentContributorFires } from './reaction-dedup';
import type { ToolInvocationEvent } from './types';

function request(
  contributor: string | null,
  workspaceId: string | null = 'ws-1',
): FireBudgetRequest<ToolInvocationEvent, string> {
  return {
    contributor,
    rule: {
      id: 'r1',
      on: 'demo:tool',
      fire: 'sink:tool',
      ...(contributor ? { source: contributor } : {}),
    },
    fire: 'sink:tool',
    event: { ctx: { workspaceId } } as unknown as ToolInvocationEvent,
    cause: { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'run-1' },
  };
}

describe('checkContributorFireBudget', () => {
  it('allows a contributor under the threshold', async () => {
    const count = vi.fn<typeof countRecentContributorFires>(async () => 12);
    const log = vi.fn<(m: string) => void>();

    const decision = await checkContributorFireBudget(request('plugin:acme'), { count, log });

    expect(decision).toEqual({ allow: true });
    expect(count).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      contributor: 'plugin:acme',
      windowMinutes: CONTRIBUTOR_FIRE_BUDGET_WINDOW_MINUTES,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('DENIES at the threshold (not only over it), naming contributor, count and budget', async () => {
    const count = vi.fn<typeof countRecentContributorFires>(
      async () => DEFAULT_CONTRIBUTOR_FIRE_BUDGET,
    );

    const decision = await checkContributorFireBudget(request('plugin:acme'), { count });

    expect(decision.allow).toBe(false);
    // The reason travels to an owner alert verbatim, so it must be actionable on
    // its own — who, how many, and against what bound.
    const reason = decision.allow === false ? decision.reason : '';
    expect(reason).toContain('plugin:acme');
    expect(reason).toContain(String(DEFAULT_CONTRIBUTOR_FIRE_BUDGET));
    expect(reason).toContain(`${CONTRIBUTOR_FIRE_BUDGET_WINDOW_MINUTES}m`);
  });

  it('denies well over the threshold too', async () => {
    const count = vi.fn<typeof countRecentContributorFires>(async () => 5_000);

    const decision = await checkContributorFireBudget(request('plugin:acme'), { count });

    expect(decision.allow).toBe(false);
  });

  it('honours an injected budget and window rather than the defaults', async () => {
    const count = vi.fn<typeof countRecentContributorFires>(async () => 3);

    const decision = await checkContributorFireBudget(request('plugin:acme'), {
      count,
      budget: 3,
      windowMinutes: 5,
    });

    expect(decision.allow).toBe(false);
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ windowMinutes: 5 }),
    );
  });

  /**
   * The exemption's real contract is not "first-party is allowed" — a denial that
   * never happens is indistinguishable from an allow. It is that first-party
   * NEVER REACHES THE LEDGER: budgeting `contributor = null` would lump every
   * built-in into one shared bucket and let the system throttle itself, and it is
   * also exactly the population migration 1169's partial index excludes.
   */
  it('EXEMPTS a first-party rule without counting anything', async () => {
    const count = vi.fn<typeof countRecentContributorFires>(async () => 9_999);

    const decision = await checkContributorFireBudget(request(null), { count });

    expect(decision).toEqual({ allow: true });
    expect(count).not.toHaveBeenCalled();
  });

  it('allows without counting when the event carries no workspace to count against', async () => {
    const count = vi.fn<typeof countRecentContributorFires>(async () => 9_999);

    const decision = await checkContributorFireBudget(request('plugin:acme', null), { count });

    // No ledger scope means no measurement was taken — allow rather than invent a
    // denial from a count that never happened.
    expect(decision).toEqual({ allow: true });
    expect(count).not.toHaveBeenCalled();
  });

  it('FAILS OPEN when the ledger throws, and says so', async () => {
    const count = vi.fn<typeof countRecentContributorFires>(async () => {
      throw new Error('connection closed');
    });
    const log = vi.fn<(m: string) => void>();

    const decision = await checkContributorFireBudget(request('plugin:acme'), { count, log });

    expect(decision).toEqual({ allow: true });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection closed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('plugin:acme'));
  });
});
