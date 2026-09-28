/**
 * WI-10003688 recurrence guard (unit tier): the embedded-PG postmaster supervisor.
 *
 * Measured 2026-09-28 on the Mac rig VM: the data volume filled, the postmaster died
 * on ENOSPC, and the operator ran against a dead database for over an hour because
 * nothing restarted it. These tests drive the supervisor with a fake child and fake
 * timers; embedded-pg-supervisor.integration.test.ts SIGKILLs a real postmaster.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  PG_RESTART_BACKOFF_MS,
  childHasExited,
  classifyPostgresDeath,
  createPostgresLogWindow,
  superviseEmbeddedPostgres,
} from '@papercusp/embedded-postgres-server/src/pg-supervisor.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  die(code: number | null, signal: string | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/** A fake embedded-postgres whose start() outcomes are scripted in order. */
function fakePg(outcomes: Array<'ok' | 'fail'>) {
  const pg = {
    process: new FakeChild() as FakeChild | undefined,
    starts: 0,
    async start() {
      pg.starts += 1;
      const outcome = outcomes.shift() ?? 'ok';
      const child = new FakeChild();
      pg.process = child;
      if (outcome === 'fail') {
        child.die(1);
        throw new Error('');
      }
    },
  };
  return pg;
}

/** Manual timers: nothing fires until the test says so. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      pending.push(t);
      return t;
    },
    clearTimer: (t: unknown) => {
      (t as { cleared: boolean }).cleared = true;
    },
    /** Fire the oldest live timer and let the restart attempt settle. */
    async fireNext() {
      const t = pending.find((p) => !p.cleared);
      if (!t) throw new Error('no pending timer');
      t.cleared = true;
      t.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    },
    live: () => pending.filter((p) => !p.cleared),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('classifyPostgresDeath', () => {
  it('names a disk-full death from the postmaster output', () => {
    expect(
      classifyPostgresDeath([
        'pg: LOG:  database system is ready',
        'pg: FATAL:  could not create file "base/16384/23900": No space left on device',
      ]),
    ).toBe('disk-full');
    expect(classifyPostgresDeath(['pg-err: write failed: ENOSPC'])).toBe('disk-full');
  });

  it('does not invent a cause it cannot see', () => {
    expect(classifyPostgresDeath(['pg: LOG:  server process (PID 1) was terminated by signal 9'])).toBe('unknown');
    expect(classifyPostgresDeath([])).toBe('unknown');
  });
});

describe('createPostgresLogWindow', () => {
  it('splits multi-line stderr chunks and keeps only the most recent lines', () => {
    const w = createPostgresLogWindow(3);
    w.push('a\nb\n');
    w.push('c\r\n\nd');
    expect(w.lines()).toEqual(['b', 'c', 'd']);
  });
});

describe('childHasExited', () => {
  it('reads both a normal exit and a signal death, and treats a live child as running', () => {
    expect(childHasExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(childHasExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true);
    expect(childHasExited({ exitCode: null, signalCode: null })).toBe(false);
    expect(childHasExited(undefined)).toBe(false);
  });
});

describe('superviseEmbeddedPostgres', () => {
  it('restarts a postmaster that died on its own and reports it', async () => {
    const pg = fakePg(['ok']);
    const timers = manualTimers();
    const logs: string[] = [];
    const exits: unknown[] = [];
    const sup = superviseEmbeddedPostgres({
      pg,
      dataDir: '/data',
      log: (m) => logs.push(m),
      recentLines: () => ['pg: LOG:  server process was terminated by signal 9'],
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onExit: (e) => exits.push(e),
    });

    pg.process!.die(null, 'SIGKILL');
    await flush();
    expect(sup.health().state).toBe('restarting');
    expect(exits).toEqual([
      expect.objectContaining({ signal: 'SIGKILL', cause: 'unknown', attempt: 1, nextAttemptInMs: PG_RESTART_BACKOFF_MS[0] }),
    ]);

    await timers.fireNext();
    expect(pg.starts).toBe(1);
    expect(sup.health()).toMatchObject({ state: 'running', restarts: 1, pendingAttempt: 0 });
    expect(logs.some((l) => l.includes('postgres restarted after 1 attempt'))).toBe(true);
  });

  it('keeps retrying a disk-full death at the capped delay until space returns, then recovers', async () => {
    const failures = PG_RESTART_BACKOFF_MS.length + 2;
    const pg = fakePg([...Array(failures).fill('fail'), 'ok']);
    const timers = manualTimers();
    const exits: Array<{ cause: string; nextAttemptInMs: number; freeBytes: number | null }> = [];
    const sup = superviseEmbeddedPostgres({
      pg,
      dataDir: '/data',
      log: () => {},
      recentLines: () => ['pg: FATAL:  could not write to file "pg_wal/xlogtemp.1": No space left on device'],
      freeBytes: async () => 32 * 1024 * 1024,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onExit: (e) => exits.push(e),
    });

    pg.process!.die(1);
    await flush();
    for (let i = 0; i < failures + 1; i++) await timers.fireNext();

    expect(pg.starts).toBe(failures + 1);
    expect(exits.every((e) => e.cause === 'disk-full' && e.freeBytes === 32 * 1024 * 1024)).toBe(true);
    const delays = exits.map((e) => e.nextAttemptInMs);
    expect(delays.slice(0, PG_RESTART_BACKOFF_MS.length)).toEqual([...PG_RESTART_BACKOFF_MS]);
    // The last step repeats: a disk-full host is never abandoned.
    const cap = PG_RESTART_BACKOFF_MS[PG_RESTART_BACKOFF_MS.length - 1];
    expect(delays.slice(PG_RESTART_BACKOFF_MS.length)).toEqual(Array(delays.length - PG_RESTART_BACKOFF_MS.length).fill(cap));
    expect(sup.health()).toMatchObject({ state: 'running', restarts: 1 });
  });

  it('watches the NEW child after a restart, so a second death is also recovered', async () => {
    const pg = fakePg(['ok', 'ok']);
    const timers = manualTimers();
    const sup = superviseEmbeddedPostgres({
      pg, dataDir: '/d', log: () => {}, recentLines: () => [],
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    pg.process!.die(1);
    await flush();
    await timers.fireNext();
    pg.process!.die(1);
    await flush();
    await timers.fireNext();
    expect(sup.health().restarts).toBe(2);
    expect(pg.starts).toBe(2);
  });

  it('treats a child that is already dead at watch time as a death', async () => {
    const pg = fakePg(['ok']);
    pg.process!.exitCode = 1;
    const timers = manualTimers();
    const sup = superviseEmbeddedPostgres({
      pg, dataDir: '/d', log: () => {}, recentLines: () => [],
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    await flush();
    expect(timers.live()).toHaveLength(1);
    await timers.fireNext();
    expect(sup.health().restarts).toBe(1);
  });

  it('does not restart after stop(), and cancels a pending attempt', async () => {
    const pg = fakePg(['ok']);
    const timers = manualTimers();
    const sup = superviseEmbeddedPostgres({
      pg, dataDir: '/d', log: () => {}, recentLines: () => [],
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    pg.process!.die(1);
    await flush();
    expect(timers.live()).toHaveLength(1);
    await sup.stop();
    expect(timers.live()).toHaveLength(0);
    expect(sup.health().state).toBe('stopped');

    // A clean stop kills the child; that exit must not trigger a restart either.
    const pg2 = fakePg([]);
    const timers2 = manualTimers();
    const sup2 = superviseEmbeddedPostgres({
      pg: pg2, dataDir: '/d', log: () => {}, recentLines: () => [],
      setTimer: timers2.setTimer, clearTimer: timers2.clearTimer,
    });
    await sup2.stop();
    pg2.process!.die(0, 'SIGINT');
    await flush();
    expect(timers2.live()).toHaveLength(0);
    expect(pg2.starts).toBe(0);
  });

  it('stop() waits for a restart attempt already in flight', async () => {
    let release!: () => void;
    const pg = {
      process: new FakeChild() as FakeChild | undefined,
      start: () => new Promise<void>((r) => { release = () => { pg.process = new FakeChild(); r(); }; }),
    };
    const timers = manualTimers();
    const sup = superviseEmbeddedPostgres({
      pg, dataDir: '/d', log: () => {}, recentLines: () => [],
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    pg.process!.die(1);
    await flush();
    timers.pending[0].fn();
    let stopped = false;
    const stopping = sup.stop().then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    // The attempt finished after stop(): it must not count as a restart or re-arm.
    expect(sup.health()).toMatchObject({ state: 'stopped', restarts: 0 });
  });
});
