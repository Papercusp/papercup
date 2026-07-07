import { describe, it, expect, vi } from 'vitest';
import {
  loopRoutineIdFromSource,
  computeDeathRearmMs,
  handleLoopResumeTurnExit,
} from './loop-turn-outcome';
import type { ResumeTurnOutcome } from '../../events/await/resume-turn-outcome';
import type { DeliveryWork } from '../../events/await/types';
import type { ResumeTurnExitRaw } from '../../events/await/resume-turn-outcome';

const INTERVAL_MS = 120_000;

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
  it('caps a very long retry-after at 1h', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 9_999_999_999 }), INTERVAL_MS)).toBe(3_600_000);
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
