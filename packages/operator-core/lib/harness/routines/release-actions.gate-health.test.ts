/**
 * EI-7472 regression: `trackGateStall` writes the whole `gate_health` jsonb key
 * (the final UPDATE uses `metadata || {gate_health: next}`, a SHALLOW top-level
 * merge that REPLACES `gate_health`). The `watchdogAlerted` field is owned by the
 * separate green-stall-watchdog sweep, NOT this writer — so `next` must carry it
 * through or every red tick silently drops it, and the watchdog re-fires its
 * one-shot STALLED severe-event ~hourly for the life of a red streak (fleet-wide
 * alarm spam). These tests capture the actual UPDATE params and assert the flag
 * survives a red tick and clears on a green/reset tick.
 *
 * Mirrors the capture-the-`sql.unsafe`-params mock pattern (a partial mock of
 * `@papercusp/db-org` that overrides only the lazy `getOrgPg`, preserving every
 * other export so the release-actions import graph still resolves).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type UnsafeCall = { query: string; params: unknown[] };
const calls: UnsafeCall[] = [];
let seededGh: Record<string, unknown> | null = null;

const fakeSql = {
  unsafe: (query: string, params: unknown[] = []) => {
    calls.push({ query, params });
    if (/SELECT\s+metadata->'gate_health'/i.test(query)) {
      return Promise.resolve([{ gh: seededGh }]);
    }
    // escalation clear (green path) reads `.count`; the routines gate_health write
    // and any escalation upsert are not read for their result.
    return Promise.resolve({ count: 0 });
  },
};

// PARTIAL mock — preserve every other @papercusp/db-org export (getHarnessAdminUrl,
// withWorkspace, …) so importing release-actions' whole graph still resolves; only
// the lazy getOrgPg is overridden to hand back our capturing fake `sql`.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

import { trackGateStall } from './release-actions';
import type { SystemActionCtx } from './system-actions';

const ctx = { installSlug: 'test-slug', workspaceId: 'test-ws' } as unknown as SystemActionCtx;

/** The final metadata write is `UPDATE harness_shared.routines SET metadata = … || $2`
 *  where `$2 = JSON.stringify({ gate_health: next })`. Pull the last such write's
 *  gate_health object back out. */
function lastGateHealthWrite(): Record<string, unknown> | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (/UPDATE\s+harness_shared\.routines/i.test(c.query) && typeof c.params[1] === 'string') {
      const parsed = JSON.parse(c.params[1] as string) as { gate_health?: Record<string, unknown> };
      if (parsed?.gate_health) return parsed.gate_health;
    }
  }
  return null;
}

beforeEach(() => {
  calls.length = 0;
  seededGh = null;
});

describe('trackGateStall gate_health cross-writer preservation (EI-7472)', () => {
  it('preserves watchdogAlerted:true across a RED tick', async () => {
    // The watchdog sweep already flipped its dedup flag; a subsequent red
    // green-checkpoint fire must not clobber it. Keep the streak below the alert
    // threshold so only the SELECT + the final gate_health UPDATE run.
    seededGh = { consecutiveReds: 0, watchdogAlerted: true, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'error');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // The bug: without carrying the field through `next`, this is `undefined`.
    expect(written!.watchdogAlerted).toBe(true);
    // Sanity: this is a real red tick (streak incremented), not a reset.
    expect(written!.consecutiveReds).toBe(1);
  });

  it('preserves watchdogAlerted:false across a RED tick (absent seed defaults to false, never dropped)', async () => {
    seededGh = { consecutiveReds: 1, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // Field is always present (false), so the watchdog's one-shot dedup read is
    // never a null/undefined that reads as "not yet alerted".
    expect(written!.watchdogAlerted).toBe(false);
  });

  it('clears watchdogAlerted on a GREEN/reset tick (recovery clears the dedup flag)', async () => {
    seededGh = { consecutiveReds: 5, watchdogAlerted: true, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(ctx, 'advanced');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.watchdogAlerted).toBe(false);
    // Sanity: the green verdict reset the streak.
    expect(written!.consecutiveReds).toBe(0);
  });
});
