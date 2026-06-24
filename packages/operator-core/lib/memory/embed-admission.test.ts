/**
 * Unit tests for the shared embed-TPM admission lane (embed-admission.ts).
 *
 * The RateLimitGovernor itself is exhaustively tested in
 * libs/papercusp-shared/src/resilience/governor.test.ts — here we test the LANE logic this
 * module adds on top: flag-off passthrough, bench-sheds / memory-passes on denial, the
 * token estimate, and the header helpers. The governor is stubbed so the tests are pure.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import {
  createEmbedAdmission,
  estimateEmbedTokens,
  headersToRecord,
  retryAfterMs,
  EmbedShedError,
  type EmbedLane,
} from './embed-admission';

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
