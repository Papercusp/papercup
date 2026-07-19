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
    // Escalation clear (green path) reads `.count`. A real DB would only have a
    // row to clear when the seeded gate_health actually believed an escalation
    // was open (`stallAlerted: true`) — mirror that here so the happy-path
    // recovery test (seed stallAlerted:true, expect a clean clear) doesn't spuriously
    // hit trackGateStall's "MATCHED 0 ROWS despite stallAlerted" warn path (that
    // warn is for a genuinely-diverged DB, which no test here is simulating).
    if (/UPDATE\s+harness_shared\.harness_escalations/i.test(query)) {
      return Promise.resolve({ count: seededGh?.stallAlerted ? 1 : 0 });
    }
    // the routines gate_health write and any escalation upsert are not read for
    // their result.
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

/**
 * EI-7505: the green-checkpoint action already parses `failingTests` from the
 * verdict and passes them into `trackGateStall`, but the function previously
 * discarded them — the persisted `gate_health` `next` object never carried a
 * `failingTests` key, forcing a responder to hand-spelunk
 * `harness_shared.test_runs` (inconclusive — it mixes every agent's local
 * dev-test runs with the verdict run) during a live deploy-freeze just to see
 * which test(s) are failing the gate. These tests assert the list is now
 * persisted on a red tick and cleared on recovery.
 */
describe('trackGateStall persists failingTests into gate_health (EI-7505)', () => {
  it('persists the failing-test list on a RED tick', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'error', 'deadbeefcafe', ['pkgA/foo.test.ts', 'pkgB/bar.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toEqual(['pkgA/foo.test.ts', 'pkgB/bar.test.ts']);
  });

  it('truncates the persisted list to 20 entries', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };
    const tests = Array.from({ length: 30 }, (_, i) => `pkg/file-${i}.test.ts`);

    await trackGateStall(ctx, 'error', 'deadbeefcafe', tests);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toHaveLength(20);
    expect(written!.failingTests).toEqual(tests.slice(0, 20));
  });

  it('persists an empty list on a RED tick with no failingTests param (never undefined)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'error');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toEqual([]);
  });

  it('clears failingTests on a GREEN/reset tick (a stale list must not linger past recovery)', async () => {
    seededGh = {
      consecutiveReds: 5,
      stallAlerted: true,
      lastGreenAt: Date.now() - 60_000,
      failingTests: ['pkgA/foo.test.ts'],
    };

    await trackGateStall(ctx, 'advanced');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toEqual([]);
  });
});

/**
 * EI-13288: green-checkpoint's stale-candidate re-triage (`classifyRedAgainstTip`) can PROVE a
 * red's named failing files pass at a newer tip, but discarded that proof before recording — a
 * reader (dev:why / coord:orient) then saw a "fresh" red naming files the gate's own evidence
 * already knew didn't reproduce. These tests assert `trackGateStall` now threads the CLI's
 * `retriage` verdict into `gate_health` (`retriageStaleTip` / `retriageDetail`), so
 * gate-verdict-freshness's Rule 3 can report the verdict as `stale-verdict` instead of a
 * misleading `red`.
 */
describe('trackGateStall persists retriage staleness into gate_health (EI-13288)', () => {
  const retriage = {
    classification: 'stale-candidate' as const,
    tip: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
    detail: '2 failing file(s) PASS at tip 6d9aff37 — the red is stale; refire cap reached',
  };

  it('persists retriageStaleTip/retriageDetail on a RED tick classified stale-candidate', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts'], null, retriage);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // Short-sha'd, matching the observedCandidate / lastFrom convention elsewhere in this blob.
    expect(written!.retriageStaleTip).toBe('6d9aff3704c9');
    expect(written!.retriageDetail).toBe(retriage.detail);
    // The streak still counts this tick — retriage staleness qualifies the FAILING-TEST NAMES,
    // it does not relax the gate's held/not-held decision (the bug's own requirement #4).
    expect(written!.consecutiveReds).toBe(1);
  });

  it('does NOT persist retriage fields for a genuinely real-red (no phantom note on a true break)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts'], null, {
      classification: 'real-red',
      tip: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
      detail: 'failures REPRODUCE at tip — genuine red, holding the gate',
    });

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });

  it('does NOT persist retriage fields when the caller has none (old CLI / no retriage available)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });

  it('a stale-candidate note does NOT outlive the red streak it was recorded on — cleared the very next tick when retriage is absent', async () => {
    seededGh = {
      consecutiveReds: 1,
      stallAlerted: false,
      lastGreenAt: Date.now() - 60_000,
      retriageStaleTip: '6d9aff3704c9',
      retriageDetail: 'stale from a prior tick',
    };

    // The NEXT red tick has no retriage info of its own (e.g. resolveTip failed) — the prior
    // tick's stale note must not linger and be misread as still describing THIS verdict.
    await trackGateStall(ctx, 'not-green', 'cafebabe1234', ['pkgA/foo.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });

  it('clears retriage fields on a GREEN/reset tick (recovery clears the stale note)', async () => {
    seededGh = {
      consecutiveReds: 5,
      stallAlerted: true,
      lastGreenAt: Date.now() - 60_000,
      retriageStaleTip: '6d9aff3704c9',
      retriageDetail: 'stale from a prior red streak',
    };

    await trackGateStall(ctx, 'advanced');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });
});
