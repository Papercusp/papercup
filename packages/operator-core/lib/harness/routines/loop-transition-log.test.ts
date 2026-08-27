import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readLatestLoopTransition,
  recordLoopTransition,
  transitionRetentionDays,
  __resetPruneThrottleForTest,
} from './loop-transition-log';

/**
 * EI-19411045952024591 — the append-only loop transition log.
 *
 * The recurrence guard that matters is the FAIL-SOFT one: this table is an instrument on
 * the hot fire path, and an instrument that can throw into the path it measures would
 * turn a diagnosis gap into an outage. Every test below that touches error handling is
 * guarding that property, not the happy path.
 */

/** A postgres-js-shaped tagged-template fake that records the statements it was given. */
function fakeSql(opts: { throwOn?: RegExp; code?: string; rows?: unknown[] } = {}) {
  const statements: { text: string; values: unknown[] }[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (opts.throwOn && opts.throwOn.test(text)) {
      const err = Object.assign(new Error('simulated postgres failure'), opts.code ? { code: opts.code } : {});
      return Promise.reject(err);
    }
    return Promise.resolve((opts.rows ?? []) as any);
  };
  return Object.assign(tag, { statements });
}

describe('readLatestLoopTransition', () => {
  it('returns the newest transition with await-suppression cause intact', async () => {
    const sql = fakeSql({
      rows: [
        {
          at: '2026-08-27T03:08:18.952Z',
          event: 'rearmed',
          actor: 'await-suppression',
          new_next_fire_at: '2026-08-27T03:17:32.159Z',
          interval_sec: '60',
          detail: {
            via: 'await-suppression',
            drivingEventKey: 'plan:stable:recovery-complete',
          },
        },
      ],
    });

    const out = await readLatestLoopTransition(
      {
        workspaceId: 'ws-1',
        installSlug: 'papercusp',
        routineName: 'loop-su-70702',
        targetOwnerId: 'su-70702',
      },
      { sql: sql as any },
    );

    expect(out).toEqual({
      status: 'found',
      transition: {
        at: '2026-08-27T03:08:18.952Z',
        event: 'rearmed',
        actor: 'await-suppression',
        newNextFireAt: '2026-08-27T03:17:32.159Z',
        intervalSec: 60,
        detail: {
          via: 'await-suppression',
          drivingEventKey: 'plan:stable:recovery-complete',
        },
      },
    });
    const select = sql.statements.find((s) => /SELECT t\.at, t\.event, t\.actor/.test(s.text));
    expect(select?.values).toEqual(['ws-1', 'papercusp', 'loop-su-70702', 'su-70702']);
  });

  it('distinguishes no transition from an unavailable transition read', async () => {
    const empty = fakeSql();
    await expect(
      readLatestLoopTransition(
        {
          workspaceId: 'ws-1',
          installSlug: 'papercusp',
          routineName: 'loop-su-70702',
          targetOwnerId: 'su-70702',
        },
        { sql: empty as any },
      ),
    ).resolves.toEqual({ status: 'none' });

    const unavailable = fakeSql({ throwOn: /SELECT t\.at, t\.event, t\.actor/ });
    await expect(
      readLatestLoopTransition(
        {
          workspaceId: 'ws-1',
          installSlug: 'papercusp',
          routineName: 'loop-su-70702',
          targetOwnerId: 'su-70702',
        },
        { sql: unavailable as any },
      ),
    ).resolves.toEqual({ status: 'unknown' });
  });
});

const PARK = {
  workspaceId: 'ws-1',
  installSlug: 'papercusp',
  routineId: 'routine-abc',
  routineName: 'loop-su-70702',
  targetRole: 'system:loop',
  targetOwnerId: 'su-70702',
  event: 'parked' as const,
  actor: 'claim-due-routine',
  newNextFireAt: 'infinity',
  intervalSec: 600,
};

describe('recordLoopTransition', () => {
  beforeEach(() => {
    __resetPruneThrottleForTest();
    vi.restoreAllMocks();
  });

  it('appends one row carrying the forensic payload (event, actor, routine identity)', async () => {
    const sql = fakeSql();
    await recordLoopTransition(sql as any, PARK);

    const insert = sql.statements.find((s) => /INSERT INTO harness_shared\.routine_loop_transitions/.test(s.text));
    expect(insert).toBeDefined();
    // The three columns the incident query keys on, plus the park sentinel.
    expect(insert!.values).toContain('parked');
    expect(insert!.values).toContain('claim-due-routine');
    expect(insert!.values).toContain('routine-abc');
    expect(insert!.values).toContain('infinity');
    expect(insert!.values).toContain('ws-1');
  });

  it('serialises detail to JSON and passes null (not undefined) for absent optionals', async () => {
    const sql = fakeSql();
    await recordLoopTransition(sql as any, {
      workspaceId: 'ws-1',
      installSlug: 'papercusp',
      routineId: 'r1',
      event: 'rearmed',
      actor: 'reconcile-loop-routines',
      newNextFireAt: '2026-08-03T04:07:16.000Z',
      detail: { via: 'lifecycle', wasParked: true, parkedMs: 2_700_000 },
    });

    const insert = sql.statements.find((s) => /INSERT INTO/.test(s.text))!;
    expect(insert.values).toContain(JSON.stringify({ via: 'lifecycle', wasParked: true, parkedMs: 2_700_000 }));
    // Absent optionals must bind as SQL NULL, never undefined (postgres-js rejects undefined).
    expect(insert.values).not.toContain(undefined);
    expect(insert.values.filter((v) => v === null).length).toBeGreaterThan(0);
  });

  it('FAIL-SOFT: a failing insert never throws into the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ throwOn: /INSERT INTO/ });

    // The guarded property: the fire path awaits nothing and can never be broken by
    // the instrument. A rejection here would surface as a failed claim/re-arm.
    await expect(recordLoopTransition(sql as any, PARK)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('FAIL-SOFT: a failing PRUNE never throws and never masks the successful insert', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ throwOn: /DELETE FROM/ });

    await expect(recordLoopTransition(sql as any, PARK)).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget prune settle

    expect(sql.statements.some((s) => /INSERT INTO/.test(s.text))).toBe(true);
    // Hygiene failure is deliberately silent — it must not spam the fire path.
    expect(warn).not.toHaveBeenCalled();
  });

  it('an ABSENT table (42P01) warns ONCE then goes quiet — the code may deploy before its migration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ throwOn: /INSERT INTO/, code: '42P01' });

    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);

    // One warn total, and no further SQL attempted: an instrument that floods the log at
    // loop cadence would bury the very signal it exists to surface.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/migration 745 not yet applied/);
    expect(sql.statements.filter((s) => /INSERT INTO/.test(s.text))).toHaveLength(1);
  });

  it('does NOT latch on a transient failure — a real write error stays visible every time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No `code`: an ordinary transient failure, not a missing relation.
    const sql = fakeSql({ throwOn: /INSERT INTO/ });

    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);

    // The quiet path is scoped to "table absent" ONLY. Latching on any error would let a
    // genuine, ongoing write fault disappear after its first occurrence.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(sql.statements.filter((s) => /INSERT INTO/.test(s.text))).toHaveLength(2);
  });

  it('throttles the piggybacked prune so it does not run on every transition', async () => {
    const sql = fakeSql();

    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);
    await new Promise((r) => setImmediate(r));

    const deletes = sql.statements.filter((s) => /DELETE FROM harness_shared\.routine_loop_transitions/.test(s.text));
    expect(deletes).toHaveLength(1);
    expect(sql.statements.filter((s) => /INSERT INTO/.test(s.text))).toHaveLength(3);
  });
});

describe('transitionRetentionDays', () => {
  const prev = process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS;
    else process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS = prev;
  });

  it('defaults to 7 days', () => {
    delete process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS;
    expect(transitionRetentionDays()).toBe(7);
  });

  it('honours an explicit override', () => {
    process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS = '30';
    expect(transitionRetentionDays()).toBe(30);
  });

  it('floors at 1 day so a bad value can never disable the evidence window', () => {
    // A 0/negative/garbage retention would prune the table to nothing on the next write —
    // silently destroying the exact history this table exists to hold.
    for (const bad of ['0', '-5', 'abc', '']) {
      process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS = bad;
      expect(transitionRetentionDays()).toBe(7);
    }
  });
});
