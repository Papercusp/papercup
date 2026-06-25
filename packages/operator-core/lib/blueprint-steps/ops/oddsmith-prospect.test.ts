import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  oddsmithProspectOp,
  parseProspectSweepArgs as parseProspectArgs,
  candidateKey,
  setOddsmithProspectDeps,
  type OddsmithProspectBridge,
  type ProspectBridgeResult,
  type ProspectCandidate,
} from './oddsmith-prospect.js';
import type { CoordOpCtx } from '../../coord-ops/types.js';

/** A minimal ctx — the op only reads workspaceId / harnessSlug / log. */
function makeCtx(over: Partial<CoordOpCtx> = {}): CoordOpCtx {
  return {
    identity: { ownerId: 'owner' },
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'oddsmith-ops',
    depth: 0,
    now: () => '2026-06-25T00:00:00.000Z',
    newId: (p: string) => `${p}-1`,
    caps: {} as CoordOpCtx['caps'],
    log: () => {},
    ...over,
  };
}

const baseBridgeResult = (over: Partial<ProspectBridgeResult> = {}): ProspectBridgeResult => ({
  toEnqueue: [],
  swept: 0,
  candidates: 0,
  deduped: 0,
  capped: 0,
  gated: false,
  byVenue: {},
  errors: 0,
  ...over,
});

afterEach(() => setOddsmithProspectDeps(null));

describe('parseProspectArgs (mirror of the @oddsmith/prospector contract)', () => {
  it('reads numeric overrides + coerces numeric strings', () => {
    expect(parseProspectArgs({ limit: 50, minLiquidity: 2000 })).toEqual({ limit: 50, minLiquidity: 2000 });
    expect(parseProspectArgs({ limit: '50', minLiquidity: '2000' })).toEqual({ limit: 50, minLiquidity: 2000 });
  });

  it('drops un-substituted templates / empty / null / NaN / negative as "unset"', () => {
    expect(parseProspectArgs({ limit: '{{ payload.limit }}', minLiquidity: '{{ payload.minLiquidity }}' })).toEqual({});
    expect(parseProspectArgs({ limit: '', minLiquidity: null })).toEqual({});
    expect(parseProspectArgs({ limit: 'abc', maxEnqueue: -5 })).toEqual({});
    expect(parseProspectArgs(null)).toEqual({});
  });

  it('coerces the preferNiche flag (bool + string forms)', () => {
    expect(parseProspectArgs({ preferNiche: true })).toEqual({ preferNiche: true });
    expect(parseProspectArgs({ preferNiche: 'yes' })).toEqual({ preferNiche: true });
    expect(parseProspectArgs({ preferNiche: 'false' })).toEqual({ preferNiche: false });
    expect(parseProspectArgs({ preferNiche: '{{ payload.preferNiche }}' })).toEqual({});
  });

  it('carries maxEnqueue through', () => {
    expect(parseProspectArgs({ maxEnqueue: '10' })).toEqual({ maxEnqueue: 10 });
  });
});

describe('candidateKey', () => {
  it('is `${venue}:${ticker}`', () => {
    expect(candidateKey({ venue: 'polymarket', ticker: '0xabc' })).toBe('polymarket:0xabc');
  });
});

describe('oddsmith:prospect op', () => {
  it('names the op and declares the bet-analysis contract', () => {
    expect(oddsmithProspectOp.name).toBe('oddsmith:prospect');
  });

  it('is registered in knownOps via the blueprint-steps index (blueprint:validate resolves it)', async () => {
    await import('../index.js');
    const { coordOpNames } = await import('../../coord-ops/registry.js');
    expect(coordOpNames().has('oddsmith:prospect')).toBe(true);
  });

  it('requires ctx.workspaceId', async () => {
    setOddsmithProspectDeps({ bridge: async () => baseBridgeResult() });
    await expect(oddsmithProspectOp.run({}, makeCtx({ workspaceId: undefined }))).rejects.toThrow(/workspaceId/);
  });

  it('enqueues one work_item per candidate the bridge returns, and tallies keys', async () => {
    const enqueued: ProspectCandidate[] = [];
    const toEnqueue: ProspectCandidate[] = [
      { venue: 'polymarket', ticker: '0xa', reasons: ['liquid'] },
      { venue: 'kalshi', ticker: 'KX-B', reasons: ['liquid', 'resolving-soon'] },
    ];
    setOddsmithProspectDeps({
      listAlreadyQueued: async () => [],
      bridge: async () => baseBridgeResult({ toEnqueue, swept: 100, candidates: 5, deduped: 2, byVenue: { polymarket: 60, kalshi: 40 } }),
      enqueue: async (c) => {
        enqueued.push(c);
        return { id: `WI-${enqueued.length}` };
      },
    });

    const r = await oddsmithProspectOp.run({ limit: '100' }, makeCtx());

    expect(enqueued).toEqual(toEnqueue);
    expect(r.enqueued).toBe(2);
    expect(r.enqueuedKeys).toEqual(['polymarket:0xa', 'kalshi:KX-B']);
    expect(r.gated).toBe(false);
    expect(r.swept).toBe(100);
    expect(r.byVenue).toEqual({ polymarket: 60, kalshi: 40 });
  });

  it('passes the papercusp backlog keys to the bridge for cross-tick dedup', async () => {
    let seenAlready: string[] | undefined;
    setOddsmithProspectDeps({
      listAlreadyQueued: async () => ['polymarket:0xa', 'kalshi:KX-Z'],
      bridge: async ({ alreadyQueued }) => {
        seenAlready = alreadyQueued;
        return baseBridgeResult();
      },
      enqueue: async () => ({ id: 'WI-x' }),
    });

    await oddsmithProspectOp.run({}, makeCtx());
    expect(seenAlready).toEqual(['polymarket:0xa', 'kalshi:KX-Z']);
  });

  it('enqueues nothing when the gate withholds', async () => {
    const enqueue = vi.fn(async () => ({ id: 'WI-x' }));
    setOddsmithProspectDeps({
      listAlreadyQueued: async () => [],
      bridge: async () => baseBridgeResult({ gated: true, gateReason: 'not-idle', swept: 100, deduped: 7 }),
      enqueue,
    });

    const r = await oddsmithProspectOp.run({}, makeCtx());
    expect(enqueue).not.toHaveBeenCalled();
    expect(r.gated).toBe(true);
    expect(r.gateReason).toBe('not-idle');
    expect(r.enqueued).toBe(0);
    expect(r.enqueuedKeys).toEqual([]);
  });

  it('catches a per-item enqueue throw — one bad enqueue never aborts the rest', async () => {
    const toEnqueue: ProspectCandidate[] = [
      { venue: 'polymarket', ticker: '0xa', reasons: ['liquid'] },
      { venue: 'polymarket', ticker: '0xb', reasons: ['liquid'] },
    ];
    setOddsmithProspectDeps({
      listAlreadyQueued: async () => [],
      bridge: async () => baseBridgeResult({ toEnqueue, errors: 1 }),
      enqueue: async (c) => {
        if (c.ticker === '0xa') throw new Error('boom');
        return { id: 'WI-2' };
      },
    });

    const r = await oddsmithProspectOp.run({}, makeCtx());
    expect(r.enqueued).toBe(1);
    expect(r.enqueuedKeys).toEqual(['polymarket:0xb']);
    expect(r.errors).toBe(2); // 1 from the bridge sweep + 1 caught enqueue
  });

  it('the unconfigured bridge fails fast with a wire-up hint', async () => {
    // Inject only the backlog reader; `bridge` falls back to the unconfigured
    // default (the setter fills omitted ports), so we exercise the real fail-fast
    // path without touching the work_items DB.
    setOddsmithProspectDeps({ listAlreadyQueued: async () => [] });
    await expect(oddsmithProspectOp.run({}, makeCtx())).rejects.toThrow(/bridge not configured/i);
  });
});
