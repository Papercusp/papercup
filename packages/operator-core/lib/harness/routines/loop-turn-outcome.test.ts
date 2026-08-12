import { describe, it, expect, vi, beforeEach } from 'vitest';

// EI-13818: handleLoopResumeTurnExit reaches these via dynamic `await import(...)` at the
// call site (not through LoopTurnOutcomeDeps), so they're mocked at the module level —
// mirroring autoloop-chronic-failure.test.ts's exact pattern for the same primitives.
vi.mock('../../pot/watchdog', () => ({ claimWatchdogFire: vi.fn() }));
vi.mock('../improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
vi.mock('../../overwatch/wake-bridge', () => ({ requestOverwatchWake: vi.fn() }));
vi.mock('../../pot/wake', () => ({ resolvePotHomeSlug: vi.fn(() => 'papercusp') }));

import {
  loopRoutineIdFromSource,
  computeDeathRearmMs,
  handleLoopResumeTurnExit,
} from './loop-turn-outcome';
import type { ResumeTurnOutcome } from '../../events/await/resume-turn-outcome';
import type { DeliveryWork } from '../../events/await/types';
import type { ResumeTurnExitRaw } from '../../events/await/resume-turn-outcome';
import { claimWatchdogFire } from '../../pot/watchdog';
import { captureImprovement } from '../improvements/capture-core';
import type { CaptureImprovementResult } from '../improvements/capture-core';
import { requestOverwatchWake } from '../../overwatch/wake-bridge';
import { mockResolvedTyped } from '../../testing/typed-mock';

const INTERVAL_MS = 120_000;

/**
 * These tests only care THAT `captureImprovement` resolved, never what it returned — but
 * the fixture is still typed rather than cast `as never`, so a new REQUIRED field on
 * CaptureImprovementResult becomes a compile error here instead of a runtime failure in
 * someone else's green-checkpoint run (EI-19282401068515102 / lint:mock-cast-escape).
 */
const CAPTURE_OK: CaptureImprovementResult = { ok: true, created: true, possibleDuplicates: [] };

const deathRaw = (over: Partial<ResumeTurnExitRaw> = {}): ResumeTurnExitRaw => ({
  exitCode: 1,
  signal: null,
  stdoutTail: 'API Error: 429 Too Many Requests · Rate limited',
  stderrTail: '',
  ...over,
});

const loopDelivery = (over: Partial<DeliveryWork> = {}): DeliveryWork =>
  ({
    id: 1,
    workspaceId: 'coord-ws',
    awaitId: 1,
    subscriberId: 'su-owner',
    eventKey: 'coord:inbox-wake:su-owner',
    payload: null,
    summary: null,
    status: 'delivered',
    channel: 'resume-headless',
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: 'loop:loop_su_owner',
    wakeHandle: null,
    note: null,
    ...over,
  }) as DeliveryWork;

/** A fake postgres-js tagged-template: routes SELECT → the routine ref, UPDATE → rearm rows,
 *  and records every call so the test can assert what ran. */
function fakeSql(opts: { ref?: Record<string, unknown> | null; rearmRows?: { id: string }[] } = {}) {
  const calls: { kind: 'select' | 'update' | 'other'; text: string }[] = [];
  const fn = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const text = strings.join('?');
    if (/^\s*SELECT/i.test(text)) {
      calls.push({ kind: 'select', text });
      return Promise.resolve(opts.ref === undefined ? [] : opts.ref ? [opts.ref] : []);
    }
    if (/UPDATE/i.test(text)) {
      calls.push({ kind: 'update', text });
      return Promise.resolve(opts.rearmRows ?? [{ id: 'loop_su_owner' }]);
    }
    calls.push({ kind: 'other', text });
    return Promise.resolve([]);
  };
  return Object.assign(fn, { calls });
}

const refRow = {
  id: 'loop_su_owner',
  name: 'loop-su-owner',
  install_slug: 'papercusp',
  workspace_id: 'ws-papercusp',
  reschedule_interval_sec: 120,
  target_owner_id: 'su-owner',
};

describe('loopRoutineIdFromSource', () => {
  it('parses loop:<id>', () => {
    expect(loopRoutineIdFromSource('loop:loop_su_owner')).toBe('loop_su_owner');
  });
  it('returns null for non-loop / empty / null sources', () => {
    expect(loopRoutineIdFromSource('lock:grant:t1')).toBeNull();
    expect(loopRoutineIdFromSource('loop:')).toBeNull();
    expect(loopRoutineIdFromSource(null)).toBeNull();
    expect(loopRoutineIdFromSource(undefined)).toBeNull();
  });
});

describe('computeDeathRearmMs (P1a — 429-aware re-arm)', () => {
  const rateDeath = (over: Partial<{ retryAfterMs: number; resetAt: number; class: string }> = {}): ResumeTurnOutcome => ({
    ok: false,
    error: { class: 'rate_limited', message: 'm', provider: 'anthropic', retryable: true, ...over } as never,
  });

  it('uses retry-after when it exceeds the interval (capped)', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 300_000 }), INTERVAL_MS)).toBe(300_000);
  });
  it('floors at the interval when retry-after is shorter', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 5_000 }), INTERVAL_MS)).toBe(INTERVAL_MS);
  });
  // WI-6852: the ceiling is 6h, not 1h. At 1h it BOUND on every real provider wall (measured:
  // 13 of 15 lifecycle-death re-arms landed on exactly 60m, so each under-waited and re-fired
  // into a still-active wall) instead of acting as the sanity rail against a bogus parse.
  it('caps an absurd retry-after at the 6h sanity ceiling', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 9_999_999_999 }), INTERVAL_MS)).toBe(6 * 3_600_000);
  });
  it('no longer clips a realistic multi-hour wall (the 1h cap used to)', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 3 * 3_600_000 }), INTERVAL_MS)).toBe(3 * 3_600_000);
  });
  it('uses resetAt - now when there is no retry-after', () => {
    const now = 1_000_000;
    const outcome: ResumeTurnOutcome = {
      ok: false,
      error: { class: 'usage_limit', message: 'm', provider: 'anthropic', retryable: false, resetAt: now + 600_000 } as never,
    };
    expect(computeDeathRearmMs(outcome, INTERVAL_MS, now)).toBe(600_000);
  });
  it('falls back to the interval for a non-rate-limit death (crash)', () => {
    const crash: ResumeTurnOutcome = {
      ok: false,
      error: { class: 'agent_crash', message: 'boom', provider: 'anthropic', retryable: true } as never,
    };
    expect(computeDeathRearmMs(crash, INTERVAL_MS)).toBe(INTERVAL_MS);
  });
});

describe('handleLoopResumeTurnExit (P0b — feed the circuit on a dead loop turn)', () => {
  it('a 429 DEATH on a loop wake records an error + re-arms the parked loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the handler logs the observed death (expected)
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('rate_limited');
    expect(res.rearmedMs).toBeGreaterThan(0);
    // Fed the EXISTING circuit with the loop's exact fire-gate key + 'error'.
    expect(recordFire).toHaveBeenCalledTimes(1);
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-owner', expect.stringContaining('rate_limited'), 'infra-error') // WI-669: infra-shaped — counter preserved;
    // Issued the re-arm UPDATE (guarded to the parked 'infinity' row).
    const update = sql.calls.find((c) => c.kind === 'update');
    expect(update).toBeTruthy();
    expect(update!.text).toContain("'infinity'");
  });

  it('a Codex exit 0 without turn.completed records malformed_output and re-arms the loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({
        exitCode: 0,
        stdoutTail: '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}',
        outputProtocol: 'codex-jsonl',
      }),
      { sql: sql as never, recordFire },
    );

    expect(res).toMatchObject({ handled: true, class: 'malformed_output' });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-owner',
      expect.stringContaining('malformed_output'),
      'error',
    );
    expect(sql.calls.some((c) => c.kind === 'update')).toBe(true);
  });

  it('a SURVIVED loop turn (clean exit) is a no-op — reconcile owns the ok reset', async () => {
    const sql = fakeSql({ ref: refRow });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw({ exitCode: 0, stdoutTail: 'done' }), {
      sql: sql as never,
      recordFire,
    });
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(0); // never even touched the DB
  });

  it('a NON-loop wake death is ignored (no attribution to any loop)', async () => {
    const sql = fakeSql({ ref: refRow });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery({ source: 'lock:grant:t1' }), deathRaw(), {
      sql: sql as never,
      recordFire,
    });
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(0);
  });

  it('a loop that has since ended (routine row gone) records nothing', async () => {
    const sql = fakeSql({ ref: null });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw(), { sql: sql as never, recordFire });
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('a context-overflow death pauses the loop and never re-arms the same oversized warm transcript', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: 'Prompt is too long: 210000 tokens > 200000 maximum' }),
      { sql: sql as never, recordFire, autoPause },
    );

    expect(res).toMatchObject({ handled: true, class: 'context_overflow' });
    expect(res.rearmedMs).toBeUndefined();
    expect(autoPause).toHaveBeenCalledWith(
      sql,
      'loop_su_owner',
      expect.stringContaining('paused to prevent repeated oversized warm wakes'),
      'loop-turn-outcome',
    );
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bug',
        body: expect.stringContaining('context-overflow terminal guard'),
      }),
    );
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });
});

describe('handleLoopResumeTurnExit — EI-13818 wedge-death alert (item c)', () => {
  const wedgeRaw = (over: Partial<ResumeTurnExitRaw> = {}): ResumeTurnExitRaw => ({
    exitCode: 0,
    signal: null,
    stdoutTail: "You've hit your session limit · resets 5:40am (America/New_York)",
    stderrTail: '',
    ...over,
  });

  beforeEach(() => {
    vi.mocked(claimWatchdogFire).mockReset().mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement).mockReset(), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockReset().mockResolvedValue({ wired: true, result: { fired: true } });
  });

  it('a wedged (usage_limit) clean-exit death claims the watchdog debounce + files + wakes overwatch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), wedgeRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('usage_limit');
    expect(claimWatchdogFire).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-papercusp',
        installSlug: 'papercusp::loop_su_owner',
        source: 'loop-wedge-death',
        windowHours: 6,
      }),
    );
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', severity: 'major', title: expect.stringContaining('LOOP WEDGED') }),
    );
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });

  it('a debounced claim (already fired within 6h) skips capture + overwatch wake entirely', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), wedgeRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true); // the circuit-feed + re-arm still happen regardless
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('a non-surfaceToUser death (rate_limited — auto-absorbed, not surfaced) never triggers the wedge alert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw(), { sql: sql as never, recordFire }); // deathRaw = 429/rate_limited, not surfaceToUser

    expect(res.handled).toBe(true);
    expect(claimWatchdogFire).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  // EI-19381528967421062: this is the item's OWN reported gap. surfaceToUser alone missed a
  // sustained rate_limited streak (dead egress proxy) whose computed re-arm delay ran
  // ~50-100 minutes with zero alert. A short/ordinary rate_limited death (the test above,
  // computed delay = the 2min floor) must stay silent; ONE whose computed delay clears the
  // chronic floor must alert despite the class being non-surfaceToUser.
  it('a CHRONIC rate_limited death (computed backoff >= the chronic floor) DOES trigger the wedge alert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    // Parses to retryAfterMs = 900_000 (15min) via classifySubprocessResult's "retry after Ns"
    // pattern — well past the interval floor (120s) AND the 10min chronic-alert floor.
    const chronicRaw = deathRaw({
      stdoutTail: 'API Error: 429 Too Many Requests · Rate limited · retry after 900 seconds',
    });
    const res = await handleLoopResumeTurnExit(loopDelivery(), chronicRaw, { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('rate_limited');
    expect(res.rearmedMs).toBe(900_000);
    expect(claimWatchdogFire).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'loop-wedge-death', windowHours: 6 }),
    );
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('chronic-backoff trigger') }),
    );
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });

  it('a rate_limited death JUST UNDER the chronic floor still stays silent (no spam on ordinary longer waits)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    // 9min — under the 10min chronic floor.
    const almostChronicRaw = deathRaw({
      stdoutTail: 'API Error: 429 Too Many Requests · Rate limited · retry after 540 seconds',
    });
    const res = await handleLoopResumeTurnExit(loopDelivery(), almostChronicRaw, { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.rearmedMs).toBe(540_000);
    expect(claimWatchdogFire).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a throwing claimWatchdogFire fails soft — the outcome contract is undisturbed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockRejectedValue(new Error('pg down'));
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), wedgeRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('usage_limit');
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});

describe('turn-settle wall nag (compaction-continuity-hardening P-006)', () => {
  const cleanExitWithAsk = (finalText: string): ResumeTurnExitRaw =>
    deathRaw({ exitCode: 0, signal: null, stdoutTail: finalText });

  it('a clean exit ending on an owner-ask with ZERO wall rows stashes the nag', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow });
    const stashWallNag = vi.fn(async () => true);
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      cleanExitWithAsk('shipped the fix.\nThe teardown is pending owner approval.'),
      {
        sql: sql as never,
        getLoopCarryNote: (async () => '## Next action\ngo') as never, // note, but NO walls rows
        stashWallNag: stashWallNag as never,
        now: 42,
      },
    );
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner', nagged: true });
    expect(stashWallNag).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-owner' },
      'The teardown is pending owner approval.',
      42,
    );
  });

  it('an owner-ask already covered by a wall row stays silent', async () => {
    const sql = fakeSql({ ref: refRow });
    const stashWallNag = vi.fn(async () => true);
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      cleanExitWithAsk('still awaiting owner OK on the PIDs.'),
      {
        sql: sql as never,
        getLoopCarryNote: (async () => '## Walls\n- zombie PIDs await owner OK — re-check: ps -p 95902') as never,
        stashWallNag: stashWallNag as never,
      },
    );
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner' });
    expect(res.nagged).toBeUndefined();
    expect(stashWallNag).not.toHaveBeenCalled();
  });

  it('a clean exit with NO owner-ask never touches the DB (pure detect gates the read)', async () => {
    const sql = fakeSql({ ref: refRow });
    const res = await handleLoopResumeTurnExit(loopDelivery(), cleanExitWithAsk('all green; ending the turn.'), {
      sql: sql as never,
      stashWallNag: vi.fn(async () => true) as never,
    });
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner' });
    expect(sql.calls).toHaveLength(0);
  });

  it('a throwing carry-note read fails soft — the outcome contract is undisturbed', async () => {
    const sql = fakeSql({ ref: refRow });
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      cleanExitWithAsk('blocked on the owner for credentials.'),
      {
        sql: sql as never,
        getLoopCarryNote: (async () => {
          throw new Error('pg down');
        }) as never,
        stashWallNag: vi.fn(async () => true) as never,
      },
    );
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner' });
    expect(res.nagged).toBeUndefined();
  });
});
