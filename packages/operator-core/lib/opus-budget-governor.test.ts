import { describe, it, expect } from 'vitest';
import type { AccountPool, ClaudeAccount } from './deployment/account-pool';
import { DRAIN_UTIL_STALE_MS } from './deployment/account-pool';
import {
  DEFAULT_OPUS_BUDGET_POLICY,
  aggregateOpusUtil,
  classifyOpusZone,
  classifyRoleCriticality,
  evaluateOpusBudget,
  type WorkCriticality,
} from './opus-budget-governor';

const NOW = 1_000_000_000_000;

/** Build a single account with an observed (fresh) 5h utilization. */
function acct(
  id: string,
  opts: {
    util?: number;
    util7d?: number;
    utilizationAt?: number;
    pausedUntil?: number;
  } = {},
): ClaudeAccount {
  return {
    id,
    credentialRef: `token:/creds/${id}`,
    addedAt: NOW - 1_000_000,
    boundTo: [],
    rate: {
      pausedUntil: opts.pausedUntil ?? 0,
      lastPenaltyAt: 0,
      penaltyCount: 0,
      windowStartedAt: 0,
      utilization: opts.util,
      utilization7d: opts.util7d,
      utilizationAt: opts.utilizationAt ?? (opts.util !== undefined || opts.util7d !== undefined ? NOW : undefined),
    },
  };
}

function pool(...accounts: ClaudeAccount[]): AccountPool {
  return { accounts };
}

describe('aggregateOpusUtil — the fleet opus-pressure signal', () => {
  it('returns null for an empty pool (no signal → governor is a no-op)', () => {
    expect(aggregateOpusUtil(pool(), NOW)).toBeNull();
  });

  it('takes the MIN effective util across available accounts (the best account we could route to)', () => {
    // 3 near-full + 1 fresh → the fresh one defines fleet pressure (opus is still available there).
    const p = pool(acct('a', { util: 0.99 }), acct('b', { util: 0.97 }), acct('c', { util: 0.95 }), acct('d', { util: 0.1 }));
    expect(aggregateOpusUtil(p, NOW)).toBeCloseTo(0.1);
  });

  it('is high only when EVERY available account is near its cap', () => {
    const p = pool(acct('a', { util: 0.9 }), acct('b', { util: 0.92 }), acct('c', { util: 0.95 }));
    expect(aggregateOpusUtil(p, NOW)).toBeCloseTo(0.9);
  });

  it('treats an unknown (never-observed) reading as 0 — a cold pool reads as full headroom', () => {
    const p = pool(acct('a', {}), acct('b', { util: 0.99 }));
    expect(aggregateOpusUtil(p, NOW)).toBe(0);
  });

  it('treats a STALE reading as 0 (un-probed headroom)', () => {
    const stale = acct('a', { util: 0.99, utilizationAt: NOW - DRAIN_UTIL_STALE_MS - 1 });
    expect(aggregateOpusUtil(pool(stale), NOW)).toBe(0);
  });

  it('is 7d-aware: a 5h-fresh-but-weekly-capped account reads near its 7d cap (the aviynw2 trap)', () => {
    const p = pool(acct('a', { util: 0.09, util7d: 0.96 }));
    expect(aggregateOpusUtil(p, NOW)).toBeCloseTo(0.96);
  });

  it('excludes paused accounts; all-paused → fully exhausted (1)', () => {
    const p = pool(acct('a', { util: 0.1, pausedUntil: NOW + 60_000 }), acct('b', { util: 0.1, pausedUntil: NOW + 60_000 }));
    expect(aggregateOpusUtil(p, NOW)).toBe(1);
  });

  it('a paused near-full account does not drag down an available fresh account', () => {
    const p = pool(acct('a', { util: 0.99, pausedUntil: NOW + 60_000 }), acct('b', { util: 0.2 }));
    expect(aggregateOpusUtil(p, NOW)).toBeCloseTo(0.2);
  });
});

describe('classifyOpusZone', () => {
  const P = DEFAULT_OPUS_BUDGET_POLICY;
  it('maps util to zones at the policy thresholds', () => {
    expect(classifyOpusZone(0.5, P)).toBe('headroom');
    expect(classifyOpusZone(P.reserveStart, P)).toBe('reserve'); // 0.75
    expect(classifyOpusZone(0.8, P)).toBe('reserve');
    expect(classifyOpusZone(P.reserveHard, P)).toBe('near-cap'); // 0.88
    expect(classifyOpusZone(0.9, P)).toBe('near-cap');
    expect(classifyOpusZone(P.nearCap, P)).toBe('exhausted'); // 0.95
    expect(classifyOpusZone(0.99, P)).toBe('exhausted');
    expect(classifyOpusZone(1, P)).toBe('exhausted');
  });
  it('null (no signal) is the headroom no-op zone', () => {
    expect(classifyOpusZone(null, P)).toBe('headroom');
  });
});

describe('classifyRoleCriticality', () => {
  it('maps ship-gating / decision / human-facing roles to critical', () => {
    for (const r of ['operator', 'su', 'queen', 'validator', 'reviewer', 'security-reviewer', 'architect', 'overwatch', 'release-manager']) {
      expect(classifyRoleCriticality(r)).toBe('critical');
    }
  });
  it('maps exploratory / optional / post-ship roles to background', () => {
    for (const r of ['scout', 'gym', 'sentinel', 'ui-qa', 'curator', 'documenter']) {
      expect(classifyRoleCriticality(r)).toBe('background');
    }
  });
  it('defaults everything else (incl. worker/bee/scoper) to normal', () => {
    for (const r of ['worker', 'bee', 'scoper', 'planner', 'debugger', 'mystery-role']) {
      expect(classifyRoleCriticality(r)).toBe('normal');
    }
  });
  it('classifies a plugin-namespaced role on its bare segment', () => {
    expect(classifyRoleCriticality('myplugin:reviewer')).toBe('critical');
    expect(classifyRoleCriticality('myplugin:scout')).toBe('background');
  });
  it('is case-insensitive and tolerates null/empty', () => {
    expect(classifyRoleCriticality('VALIDATOR')).toBe('critical');
    expect(classifyRoleCriticality(null)).toBe('normal');
    expect(classifyRoleCriticality('')).toBe('normal');
  });
});

describe('evaluateOpusBudget — graduated shedding', () => {
  const evalAt = (util: number | null, criticality: WorkCriticality) => {
    // Construct a pool whose aggregate (min over available) equals `util`. A single account suffices.
    const p = util === null ? pool() : pool(acct('a', { util }));
    return evaluateOpusBudget({ pool: p, criticality, now: NOW });
  };

  it('HEADROOM (util 0.5): nothing sheds, nothing paces', () => {
    for (const c of ['background', 'normal', 'critical'] as WorkCriticality[]) {
      const d = evalAt(0.5, c);
      expect(d.zone).toBe('headroom');
      expect(d.downgrade).toBe(false);
      expect(d.pace).toBe(false);
    }
  });

  it('RESERVE (util 0.80): only background sheds', () => {
    expect(evalAt(0.8, 'background').downgrade).toBe(true);
    expect(evalAt(0.8, 'normal').downgrade).toBe(false);
    expect(evalAt(0.8, 'critical').downgrade).toBe(false);
    expect(evalAt(0.8, 'critical').pace).toBe(false);
  });

  it('NEAR-CAP (util 0.90): background + normal shed; critical keeps opus, not yet paced', () => {
    expect(evalAt(0.9, 'background').downgrade).toBe(true);
    expect(evalAt(0.9, 'normal').downgrade).toBe(true);
    const crit = evalAt(0.9, 'critical');
    expect(crit.downgrade).toBe(false);
    expect(crit.pace).toBe(false);
  });

  it('EXHAUSTED (util 0.97): background + normal shed; critical keeps opus but is PACED', () => {
    expect(evalAt(0.97, 'background').downgrade).toBe(true);
    expect(evalAt(0.97, 'normal').downgrade).toBe(true);
    const crit = evalAt(0.97, 'critical');
    expect(crit.downgrade).toBe(false);
    expect(crit.pace).toBe(true);
  });

  it('cold / empty pool (null util): never downgrades — pacing is never on missing data', () => {
    for (const c of ['background', 'normal', 'critical'] as WorkCriticality[]) {
      const d = evalAt(null, c);
      expect(d.aggregateUtil).toBeNull();
      expect(d.zone).toBe('headroom');
      expect(d.downgrade).toBe(false);
      expect(d.pace).toBe(false);
    }
  });

  it('reports headroom-under-the-cap for observability', () => {
    expect(evalAt(0.8, 'normal').headroom).toBeCloseTo(DEFAULT_OPUS_BUDGET_POLICY.nearCap - 0.8);
    expect(evalAt(0.99, 'normal').headroom).toBe(0);
    expect(evalAt(null, 'normal').headroom).toBeNull();
  });

  it('ACCEPTANCE — opus throughput is paced below the ceiling: shed-set grows monotonically as util climbs', () => {
    // Sweep utilization upward; count how many criticality classes still get opus. As the fleet
    // approaches the 5h ceiling, fewer classes keep opus (more demand sheds to sonnet) — the
    // mechanism that holds the aggregate UNDER the cap instead of blowing through it.
    const classes: WorkCriticality[] = ['background', 'normal', 'critical'];
    const opusKeptAt = (util: number) =>
      classes.filter((c) => !evaluateOpusBudget({ pool: pool(acct('a', { util })), criticality: c, now: NOW }).downgrade).length;

    const sweep = [0.1, 0.5, 0.74, 0.75, 0.85, 0.88, 0.9, 0.95, 0.99];
    const kept = sweep.map(opusKeptAt);
    // monotonically non-increasing as pressure rises
    for (let i = 1; i < kept.length; i++) expect(kept[i]).toBeLessThanOrEqual(kept[i - 1]);
    expect(kept[0]).toBe(3); // headroom: all three keep opus
    expect(kept[kept.length - 1]).toBe(1); // near the ceiling: only critical keeps opus
  });

  it('ACCEPTANCE — non-critical work shifts to sonnet under budget pressure (background first, then normal)', () => {
    // background sheds the moment the reserve zone opens; normal holds until near-cap.
    expect(evalAt(0.76, 'background').downgrade).toBe(true);
    expect(evalAt(0.76, 'normal').downgrade).toBe(false);
    expect(evalAt(0.89, 'normal').downgrade).toBe(true);
  });
});
