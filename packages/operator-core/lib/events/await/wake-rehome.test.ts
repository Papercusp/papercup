/**
 * P-013 part A (review-system-rework-reduction-2026-09-23, RSR-P-013-A): the pure
 * re-home decision for a dead session's wake. The dispatcher wiring is pinned in
 * wake-executor.test.ts ("dead-session wake re-home on a walled account").
 */
import { describe, expect, it } from 'vitest';
import type { AccountPool, ClaudeAccount } from '../../deployment/account-pool';
import { autoWakeAccountRoute, wakeAccountRouteFromArgv } from '../../inference-gateway/spawn-env';
import { decideWakeRehome } from './wake-rehome';

const NOW = 1_800_000_000_000;

function account(id: string, walled: boolean, provider: 'claude' | 'codex' = 'claude'): ClaudeAccount {
  return {
    id,
    provider,
    credentialRef: `token:/tmp/${id}`,
    addedAt: 1,
    boundTo: [],
    // A pause running past NOW is the measured wall (accountFull ⇐ !isAvailable).
    rate: { pausedUntil: walled ? NOW + 3_600_000 : 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
  };
}

const pool = (...accounts: ClaudeAccount[]): AccountPool => ({ accounts });
const pin = (id: string) => wakeAccountRouteFromArgv(['psu', `--account=${id}`], 'su-x');

describe('decideWakeRehome', () => {
  it('a walled hard pin with another claude account open → rehome-account', () => {
    const d = decideWakeRehome({
      route: pin('a1'),
      claudePool: pool(account('a1', true), account('a2', false)),
      codexPool: pool(),
      now: NOW,
    });
    expect(d).toMatchObject({ action: 'rehome-account', fromAccountId: 'a1' });
  });

  it('a pin with headroom → keep (never re-routes a healthy pin)', () => {
    const d = decideWakeRehome({
      route: pin('a1'),
      claudePool: pool(account('a1', false), account('a2', false)),
      codexPool: pool(account('c1', false, 'codex')),
      now: NOW,
    });
    expect(d.action).toBe('keep');
  });

  it('every claude account walled + a codex account with headroom → rehome-backend codex', () => {
    const d = decideWakeRehome({
      route: pin('a1'),
      claudePool: pool(account('a1', true), account('a2', true)),
      codexPool: pool(account('c1', false, 'codex')),
      now: NOW,
    });
    expect(d).toMatchObject({ action: 'rehome-backend', backend: 'codex' });
  });

  it('every claude account walled on an AUTO or DEFAULT route also ports to codex', () => {
    for (const route of [autoWakeAccountRoute('su-x'), wakeAccountRouteFromArgv(['psu', '--account=default'], 'su-x'), null]) {
      const d = decideWakeRehome({
        route,
        claudePool: pool(account('a1', true)),
        codexPool: pool(account('c1', false, 'codex')),
        now: NOW,
      });
      expect(d.action).toBe('rehome-backend');
    }
  });

  it('every claude AND every codex account walled → keep (no better home; existing wall path applies)', () => {
    const d = decideWakeRehome({
      route: pin('a1'),
      claudePool: pool(account('a1', true)),
      codexPool: pool(account('c1', true, 'codex')),
      now: NOW,
    });
    expect(d.action).toBe('keep');
  });

  it('an EMPTY codex pool is not evidence codex can serve → keep', () => {
    const d = decideWakeRehome({
      route: pin('a1'),
      claudePool: pool(account('a1', true)),
      codexPool: pool(),
      now: NOW,
    });
    expect(d.action).toBe('keep');
  });

  it('an auto route with some claude headroom → keep (the gateway already fails over)', () => {
    const d = decideWakeRehome({
      route: autoWakeAccountRoute('su-x'),
      claudePool: pool(account('a1', true), account('a2', false)),
      codexPool: pool(account('c1', false, 'codex')),
      now: NOW,
    });
    expect(d.action).toBe('keep');
  });

  it('an empty claude pool or an unknown pinned id → keep (unknown is not walled)', () => {
    expect(
      decideWakeRehome({ route: pin('a1'), claudePool: pool(), codexPool: pool(account('c1', false, 'codex')), now: NOW }).action,
    ).toBe('keep');
    expect(
      decideWakeRehome({
        route: pin('ghost'),
        claudePool: pool(account('a1', false)),
        codexPool: pool(),
        now: NOW,
      }).action,
    ).toBe('keep');
  });
});

describe('autoWakeAccountRoute', () => {
  it('is byte-identical to the route a persisted --account=auto reconstructs', () => {
    expect(autoWakeAccountRoute('su-x')).toEqual(wakeAccountRouteFromArgv(['psu', '--account=auto'], 'su-x'));
    expect(autoWakeAccountRoute('su-x').mode).toBe('auto');
    expect(autoWakeAccountRoute('su-x').accountId).toBeNull();
  });
});
