/**
 * Unit tests for the shared embed-TPM admission lane (embed-admission.ts).
 *
 * The RateLimitGovernor itself is exhaustively tested in
 * libs/papercusp-shared/src/resilience/governor.test.ts — here we test the LANE logic this
 * module adds on top: flag-off passthrough, bench-sheds / memory-passes on denial, the
 * token estimate, and the header helpers. The governor is stubbed so the tests are pure.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import {
  createEmbedAdmission,
  estimateEmbedTokens,
  headersToRecord,
  retryAfterMs,
  EmbedShedError,
  EmbedBudgetExhaustedError,
  type EmbedLane,
} from './embed-admission';
import {
  __resetEmbedExhaustionAlertForTest,
  __setEmbedExhaustionNotifierForTest,
} from './embed-exhaustion-alert';

afterEach(() => {
  __resetEmbedExhaustionAlertForTest();
});

/** A governor stub whose `acquire` is scripted: grant (returns a release fn) or deny (null). */
function stubGovernor(opts: {
  grant: boolean;
  onAcquire?: (est: unknown, o: unknown) => void;
}): { governor: RateLimitGovernor; released: { n: number }; recorded: unknown[]; penalties: unknown[] } {
  const released = { n: 0 };
  const recorded: unknown[] = [];
  const penalties: unknown[] = [];
  const governor = {
    acquire: vi.fn(async (est: unknown, o: unknown) => {
      opts.onAcquire?.(est, o);
      return opts.grant ? () => { released.n += 1; } : null;
    }),
    recordResponse: vi.fn((h: unknown) => { recorded.push(h); }),
    penalize: vi.fn((p: unknown) => { penalties.push(p); }),
  } as unknown as RateLimitGovernor;
  return { governor, released, recorded, penalties };
}

const enabled = () => Promise.resolve(true);
const disabled = () => Promise.resolve(false);

describe('estimateEmbedTokens', () => {
  it('is ~chars/4 with a floor of 1', () => {
    expect(estimateEmbedTokens('')).toBe(1);
    expect(estimateEmbedTokens('abcd')).toBe(1);
    expect(estimateEmbedTokens('a'.repeat(400))).toBe(100);
  });
});

describe('createEmbedAdmission — flag off', () => {
  it('passes through WITHOUT touching the governor (both lanes get a non-null slot)', async () => {
    const { governor } = stubGovernor({ grant: false });
    const adm = createEmbedAdmission({ governor, isEnabled: disabled });
    for (const lane of ['memory', 'bench'] as EmbedLane[]) {
      const slot = await adm.acquire('hello', lane);
      expect(slot).not.toBeNull();
      expect(() => slot!.release()).not.toThrow(); // no-op release
    }
    expect(governor.acquire).not.toHaveBeenCalled();
  });
});

describe('createEmbedAdmission — granted', () => {
  it('returns a slot whose release calls through to the governor', async () => {
    const { governor, released } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled });
    const slot = await adm.acquire('hi', 'bench');
    expect(slot).not.toBeNull();
    slot!.release();
    expect(released.n).toBe(1);
  });

  it('charges the estimated input tokens and the lane wait budget', async () => {
    let seenEst: any;
    let seenOpts: any;
    const { governor } = stubGovernor({
      grant: true,
      onAcquire: (est, o) => { seenEst = est; seenOpts = o; },
    });
    const adm = createEmbedAdmission({
      governor,
      isEnabled: enabled,
      laneWaitMs: { memory: 9000, bench: 1000 },
    });
    await adm.acquire('a'.repeat(40), 'bench');
    expect(seenEst).toEqual({ inTok: 10 });
    expect(seenOpts).toEqual({ maxWaitMs: 1000 });
  });
});

describe('createEmbedAdmission — denied (the priority asymmetry)', () => {
  it('bench SHEDS → null (caller degrades to BM25)', async () => {
    const { governor } = stubGovernor({ grant: false });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled });
    const slot = await adm.acquire('q', 'bench');
    expect(slot).toBeNull();
  });

  it('memory PROCEEDS → passthrough (production recall never hard-fails on admission)', async () => {
    const { governor } = stubGovernor({ grant: false });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled });
    const slot = await adm.acquire('q', 'memory');
    expect(slot).not.toBeNull();
    expect(() => slot!.release()).not.toThrow();
  });

  it('memory waits LONGER than bench so it wins the shared slot under contention', async () => {
    const waits: Record<EmbedLane, number> = { memory: 5000, bench: 2500 };
    expect(waits.memory).toBeGreaterThan(waits.bench);
  });
});

describe('recordResponse / penalize forward to the governor', () => {
  it('recordResponse passes headers through', async () => {
    const { governor, recorded } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled });
    adm.recordResponse({ 'x-ratelimit-remaining-tokens': '0' });
    expect(recorded).toEqual([{ 'x-ratelimit-remaining-tokens': '0' }]);
  });

  it('penalize always marks rateLimited (an embed 429 is a rate signal)', async () => {
    const { governor, penalties } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled });
    adm.penalize({ retryAfterMs: 1234 });
    expect(penalties).toEqual([{ rateLimited: true, retryAfterMs: 1234 }]);
  });
});

describe('header helpers', () => {
  it('headersToRecord flattens a fetch Headers', () => {
    const h = new Headers({ 'x-ratelimit-remaining-tokens': '5', 'retry-after': '2' });
    const rec = headersToRecord(h);
    expect(rec['x-ratelimit-remaining-tokens']).toBe('5');
    expect(rec['retry-after']).toBe('2');
  });

  it('retryAfterMs parses bare seconds', () => {
    expect(retryAfterMs({ 'retry-after': '2' })).toBe(2000);
  });

  it('retryAfterMs returns undefined when absent', () => {
    expect(retryAfterMs({})).toBeUndefined();
  });

  it('headersToRecord tolerates undefined/null headers (mocked fetch, edge transports)', () => {
    expect(headersToRecord(undefined)).toEqual({});
    expect(headersToRecord(null)).toEqual({});
  });
});

describe('EmbedShedError', () => {
  it('carries the lane and a stable message', () => {
    const e = new EmbedShedError('bench');
    expect(e.lane).toBe('bench');
    expect(e.message).toBe('embed_admission_shed:bench');
    expect(e).toBeInstanceOf(Error);
  });
});

// cost-audit-2026-06-29: the hard daily SPEND cap — the backstop that keeps a low-balance key
// from being drained by a runaway (bench/backfill) loop. estimateEmbedTokens('a'*40) === 10.
describe('createEmbedAdmission — daily spend cap', () => {
  it('throws EmbedBudgetExhaustedError once the cumulative day tokens exceed the cap (both lanes)', async () => {
    const { governor } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled, dailyTokenCap: 15 });
    await adm.acquire('a'.repeat(40), 'memory'); // +10 → 10 (ok)
    await expect(adm.acquire('a'.repeat(40), 'memory')).rejects.toBeInstanceOf(EmbedBudgetExhaustedError); // 10+10>15
    // and it stops the bench lane too
    const adm2 = createEmbedAdmission({ governor, isEnabled: enabled, dailyTokenCap: 15 });
    await adm2.acquire('a'.repeat(40), 'bench');
    await expect(adm2.acquire('a'.repeat(40), 'bench')).rejects.toBeInstanceOf(EmbedBudgetExhaustedError);
  });

  it('raises a deduped owner alert when the daily cap binds', async () => {
    const notify = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify);
    const { governor } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled, dailyTokenCap: 15 });

    await adm.acquire('a'.repeat(40), 'memory');
    await expect(adm.acquire('a'.repeat(40), 'memory')).rejects.toBeInstanceOf(EmbedBudgetExhaustedError);
    await expect(adm.acquire('a'.repeat(40), 'memory')).rejects.toBeInstanceOf(EmbedBudgetExhaustedError);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'daily_cap', conditionKey: 'embed-exhaustion:daily_cap' });
  });

  it('enforces the cap EVEN WITH the admission flag OFF (a spend ceiling is not flag-defeatable)', async () => {
    const { governor } = stubGovernor({ grant: false });
    const adm = createEmbedAdmission({ governor, isEnabled: disabled, dailyTokenCap: 15 });
    await adm.acquire('a'.repeat(40), 'memory'); // passthrough, but charged +10
    await expect(adm.acquire('a'.repeat(40), 'memory')).rejects.toBeInstanceOf(EmbedBudgetExhaustedError);
    expect(governor.acquire).not.toHaveBeenCalled(); // flag off → never touched the governor
  });

  it('does NOT charge the budget when a bench embed is SHED (no embed fires)', async () => {
    const { governor } = stubGovernor({ grant: false }); // governor denies → bench sheds → null
    const adm = createEmbedAdmission({ governor, isEnabled: enabled, dailyTokenCap: 100 });
    for (let i = 0; i < 5; i++) expect(await adm.acquire('a'.repeat(40), 'bench')).toBeNull();
    expect(adm.usage().dayTokens).toBe(0); // shed rows never spent → never charged
  });

  it('resets the counter on the UTC-day rollover (injected clock)', async () => {
    let t = 0;
    const { governor } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled, dailyTokenCap: 15, now: () => t });
    await adm.acquire('a'.repeat(40), 'memory'); // day 0 → 10
    expect(adm.usage().dayTokens).toBe(10);
    t += 86_400_000; // advance one full day
    await adm.acquire('a'.repeat(40), 'memory'); // new day → counter reset → 10 again, no throw
    expect(adm.usage().dayTokens).toBe(10);
  });

  it('cap = 0 disables the cap entirely (never throws, usage.overBudget false)', async () => {
    const { governor } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled, dailyTokenCap: 0 });
    for (let i = 0; i < 50; i++) await adm.acquire('a'.repeat(4000), 'memory'); // 50 × 1000 tok
    expect(adm.usage().overBudget).toBe(false);
  });

  it('usage() reports day tokens, cap, and the overBudget latch', async () => {
    const { governor } = stubGovernor({ grant: true });
    const adm = createEmbedAdmission({ governor, isEnabled: enabled, dailyTokenCap: 10 });
    expect(adm.usage()).toMatchObject({ dayTokens: 0, capTokens: 10, overBudget: false });
    await adm.acquire('a'.repeat(40), 'memory'); // +10 → exactly at cap
    expect(adm.usage()).toMatchObject({ dayTokens: 10, capTokens: 10, overBudget: true });
  });
});

describe('EmbedBudgetExhaustedError', () => {
  it('carries the lane and a message embedFailureReason can match', () => {
    const e = new EmbedBudgetExhaustedError('memory');
    expect(e.lane).toBe('memory');
    expect(e.message).toBe('embed_daily_budget_exhausted:memory');
    expect(e).toBeInstanceOf(Error);
  });
});
