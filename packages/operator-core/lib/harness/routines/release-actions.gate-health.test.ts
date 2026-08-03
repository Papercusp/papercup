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

// EI-19329732364513693: trackGateStall now measures candidate staleness via git whenever a
// candidate is passed. Keep this file HERMETIC — without this mock, every existing test that
// passes a candidate would spawn REAL `git` against integrationRoot(): slow, environment-
// dependent, and pointed at a path that need not exist in CI. The measurement is fail-safe, so
// a non-zero exit simply yields nulls; the tests that care about the VALUES inject their own
// runner rather than relying on this mock.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => ({
      stdout: { on: () => {} },
      on: (evt: string, cb: (code?: number) => void) => {
        if (evt === 'close') cb(1);
      },
    }),
  };
});

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

import { trackGateStall, measureCandidateStaleness, type GitCheckRunner } from './release-actions';
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

/**
 * EI-19329732364513693: a red verdict names failing tests, and both agents and the
 * release-fixer dispatcher act on those names — but nothing in `gate_health` said how OLD the
 * judged candidate was, so a red on a candidate the tree had long moved past read exactly like
 * a red on current code.
 *
 * Measured 2026-08-02: five failures across two consecutive reds, every one already GREEN at
 * tip. The component→test skew windows were 34min and 2h11m, and the run fired at 11:15:03Z
 * was cut 39 SECONDS before the fix for the very tests it judged. Six-plus agents chased those
 * phantoms for most of a night.
 *
 * These assert the verdict now self-discloses its own staleness.
 */
describe('trackGateStall persists candidate staleness into gate_health (EI-19329732364513693)', () => {
  /** Fake git: `log -1 --format=%cI` → commit time, `rev-list --count` → distance behind tip.
   *  A null argument makes that specific git call FAIL, to exercise the fail-safe path. */
  const stalenessRunner = (commitIso: string | null, behind: string | null): GitCheckRunner =>
    async (_root, args) => {
      if (args[0] === 'log') return { ok: commitIso != null, stdout: commitIso ?? '' };
      if (args[0] === 'rev-list') return { ok: behind != null, stdout: behind ?? '' };
      return { ok: false, stdout: '' };
    };

  it('measureCandidateStaleness reads the commit time and the distance behind tip', async () => {
    const out = await measureCandidateStaleness(
      '/repo',
      'deadbeefcafe',
      stalenessRunner('2026-08-02T02:27:59Z', '86'),
    );
    expect(out.candidateCommittedAt).toBe('2026-08-02T02:27:59Z');
    expect(out.commitsBehindTip).toBe(86);
  });

  it('counts commits reachable from staging but NOT the candidate (the `<candidate>..staging` direction)', async () => {
    const seen: string[][] = [];
    const spy: GitCheckRunner = async (_root, args) => {
      seen.push(args);
      return { ok: true, stdout: args[0] === 'log' ? '2026-08-02T02:27:59Z' : '5' };
    };
    await measureCandidateStaleness('/repo', 'deadbeefcafe', spy);
    // Direction matters: `staging..<candidate>` would answer the opposite question and report
    // 0 for exactly the ancient candidates this exists to flag.
    expect(seen).toContainEqual(['rev-list', '--count', 'deadbeefcafe..staging']);
  });

  it('is FAIL-SAFE — a git error yields nulls rather than throwing', async () => {
    const out = await measureCandidateStaleness('/repo', 'deadbeefcafe', stalenessRunner(null, null));
    expect(out.candidateCommittedAt).toBeNull();
    expect(out.commitsBehindTip).toBeNull();
  });

  it('reports a null distance when the count is unparseable, never NaN', async () => {
    const out = await measureCandidateStaleness('/repo', 'deadbeefcafe', stalenessRunner('2026-08-02T02:27:59Z', 'not-a-number'));
    // NaN would serialize into the jsonb blob as `null` anyway, but via a route that also
    // makes arithmetic on the field silently wrong — reject it at the source.
    expect(out.commitsBehindTip).toBeNull();
    expect(out.candidateCommittedAt).toBe('2026-08-02T02:27:59Z');
  });

  it('⭐ persists candidateCommittedAt + commitsBehindTip on a RED tick (the branch that misleads)', async () => {
    seededGh = { consecutiveReds: 1, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(
      ctx,
      'not-green',
      'bb054adbccf5',
      ['pkgA/foo.test.ts'],
      null,
      undefined,
      null,
      stalenessRunner('2026-08-02T02:27:59Z', '86'),
    );

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.candidateCommittedAt).toBe('2026-08-02T02:27:59Z');
    expect(written!.commitsBehindTip).toBe(86);
    // The staleness must sit alongside the verdict it qualifies, not replace it.
    expect(written!.observedCandidate).toBe('bb054adbccf5');
    expect(written!.failingTests).toEqual(['pkgA/foo.test.ts']);
  });

  it('carries the fields through a GREEN/reset tick too (the whole-object replace must not drop them)', async () => {
    seededGh = { consecutiveReds: 5, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(ctx, 'advanced', 'bb054adbccf5', [], null, undefined, null, stalenessRunner('2026-08-02T02:27:59Z', '3'));

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // EI-7472: gate_health is REPLACED wholesale on every write, so a field present only in
    // the red branch silently vanishes the moment the gate recovers.
    expect(written).toHaveProperty('candidateCommittedAt');
    expect(written).toHaveProperty('commitsBehindTip');
    expect(written!.commitsBehindTip).toBe(3);
  });

  it('records nulls and makes NO git call when the verdict carries no candidate', async () => {
    seededGh = { consecutiveReds: 1, lastGreenAt: Date.now() - 60_000 };
    let called = 0;
    const counting: GitCheckRunner = async () => {
      called++;
      return { ok: true, stdout: '1' };
    };

    await trackGateStall(ctx, 'error', undefined, undefined, null, undefined, null, counting);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.candidateCommittedAt).toBeNull();
    expect(written!.commitsBehindTip).toBeNull();
    expect(called).toBe(0);
  });
});

/**
 * EI-19405864032365760 regression: a `migrations-pending` preflight ABORT must be RECORDED
 * (so every read surface can say "no verdict was rendered") while still not COUNTING as a red.
 *
 * Those two are different claims, and collapsing them is the bug: `classifyGateStallStatus`
 * correctly returns 'noop' (a tick that judged no code is not evidence of a broken build), but
 * the noop branch then returned without writing ANYTHING — leaving `consecutiveReds`,
 * `observedCandidate` and `failingTests` frozen on the PREVIOUS verdict. Every consumer kept
 * rendering that stale red as current. Measured live 2026-08-03: ~2.5h of a fleet being told
 * "Gate is RED — the reds are yours to fix" and chasing unrelated test files while the real
 * blocker was one migration failing to apply.
 */
describe('trackGateStall records an inconclusive ABORT without counting it as a red (EI-19405864032365760)', () => {
  /** The abort write is path-scoped (`jsonb_set(… '{gate_health,inconclusive}' …)`), NOT the
   *  whole-key `metadata || {gate_health: …}` replace — that distinction is the point (it cannot
   *  shadow a concurrent counter write), so it needs its own capture. */
  function lastInconclusiveWrite(): Record<string, unknown> | null {
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i];
      if (/jsonb_set/i.test(c.query) && /gate_health,inconclusive/.test(c.query) && typeof c.params[1] === 'string') {
        return JSON.parse(c.params[1] as string) as Record<string, unknown>;
      }
    }
    return null;
  }

  it('⭐ records status + candidate + the pending-migration detail on a migrations-pending abort', async () => {
    seededGh = { consecutiveReds: 3, stallAlerted: true, failingTests: ['pkgA/old.test.ts'], observedCandidate: 'oldcandidat' };

    await trackGateStall(ctx, 'migrations-pending', 'deadbeefcafe1234', undefined, null, undefined, '727-widen-vectors.sql: null value in column "vector"');

    const inc = lastInconclusiveWrite();
    // The bug: before this fix the noop branch returned early and wrote nothing at all.
    expect(inc).not.toBeNull();
    expect(inc!.status).toBe('migrations-pending');
    expect(inc!.candidate).toBe('deadbeefcafe');
    // The detail is the ONLY place the blocking migration is named — a reader who cannot see it
    // has no path from "main is stuck" to "migration 727 is failing".
    expect(inc!.detail).toContain('727-widen-vectors.sql');
    expect(typeof inc!.observedAtMs).toBe('number');
  });

  it('⭐ leaves the red counters completely untouched — the abort is recorded, never counted', async () => {
    seededGh = { consecutiveReds: 3, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(ctx, 'migrations-pending', 'deadbeefcafe1234', undefined, null, undefined, 'pending: 727');

    // EI-2615 / EI-18757975681519069 hold: no whole-key gate_health write, so no
    // consecutiveReds increment, no firstRedAt, no stall escalation.
    expect(lastGateHealthWrite()).toBeNull();
    expect(calls.some((c) => /harness_escalations/i.test(c.query))).toBe(false);
  });

  it('⭐ writes NOTHING for skipped-locked — a peer run is producing the real verdict (EI-2615)', async () => {
    // Deliberately NOT widened to the whole noop class: there a peer run IS in flight and about
    // to write the real verdict, which is precisely the write EI-2615 proved must not be raced.
    seededGh = { consecutiveReds: 2, stallAlerted: false };

    await trackGateStall(ctx, 'skipped-locked', 'deadbeefcafe1234', undefined, null, undefined, 'a peer holds the lock');

    expect(lastInconclusiveWrite()).toBeNull();
    expect(lastGateHealthWrite()).toBeNull();
  });

  it('⭐ a subsequent RED verdict clears the recorded abort (it superseded it)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now(), inconclusive: { status: 'migrations-pending' } };

    await trackGateStall(ctx, 'not-green', 'cafebabe1234', ['pkgA/foo.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // Explicit null, not merely absent: a stale abort note outliving the verdict that
    // superseded it is the same class of bug as a stale failingTests list (EI-7505).
    expect(written!.inconclusive).toBeNull();
    expect(written!.consecutiveReds).toBe(1);
  });

  it('⭐ a subsequent GREEN verdict clears the recorded abort', async () => {
    seededGh = { consecutiveReds: 2, stallAlerted: false, inconclusive: { status: 'migrations-pending' } };

    await trackGateStall(ctx, 'advanced', 'cafebabe1234');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.inconclusive).toBeNull();
    expect(written!.consecutiveReds).toBe(0);
  });
});
