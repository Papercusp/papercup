/**
 * WI-10004954 — unit half of the graceful-shutdown recovery credit.
 *
 * 1. PIN: the credit is only correct while the installed DBOS SDK charges an attempt on
 *    every dequeue, re-enqueues an executor's PENDING workflows on boot, and dead-letters
 *    at `claimedAttempts > maxRecoveryAttempts + 1`. If an SDK upgrade changes any of
 *    those, this fails so the credit is re-derived instead of silently over- or
 *    under-crediting.
 * 2. The signal arming: fires once, logs what it credited, keeps the attempt counted on
 *    failure, and never suppresses the process's default exit when it is the only listener.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GRACEFUL_RECOVERY_CREDIT_SOLE_LISTENER_EXIT_MS,
  armGracefulShutdownRecoveryCredit,
} from './graceful-shutdown-recovery-credit';

const require = createRequire(import.meta.url);

function sdkSource(file: string): string {
  const pkgDir = dirname(require.resolve('@dbos-inc/dbos-sdk/package.json'));
  return readFileSync(join(pkgDir, 'dist', 'src', file), 'utf8');
}

describe('DBOS SDK recovery-attempt semantics the credit depends on', () => {
  it('charges recovery_attempts on the dequeue claim flip', () => {
    const sysdb = sdkSource('system_database.js');
    expect(sysdb).toMatch(/recovery_attempts = recovery_attempts \+ 1/);
  });

  it('re-enqueues an executor\'s PENDING workflows on boot recovery', () => {
    expect(sdkSource('dbos-executor.js')).toContain('reenqueueWorkflowsForRecovery');
  });

  it('dead-letters once claimed attempts exceed maxRecoveryAttempts + 1', () => {
    expect(sdkSource('dbos-executor.js')).toContain('claimedAttempts > maxRecoveryAttempts + 1');
  });
});

type BeginFn = (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;

function fakeSql(result: () => Promise<{ workflow_uuid: string }[]>): { begin: BeginFn } {
  const tx = Object.assign(
    (() => result()) as unknown as (...args: unknown[]) => Promise<{ workflow_uuid: string }[]>,
    { unsafe: async () => [] },
  );
  return { begin: async (cb) => cb(tx) };
}

function fakeProc(): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> } {
  const em = new EventEmitter() as EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
  em.pid = 4242;
  em.kill = vi.fn();
  return em;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('armGracefulShutdownRecoveryCredit', () => {
  it('credits once on SIGTERM and logs the workflows it credited', async () => {
    const proc = fakeProc();
    proc.on('SIGTERM', () => {}); // the host's own shutdown handler
    const log = vi.fn();
    const result = vi.fn(async () => [{ workflow_uuid: 'wf-long' }]);
    armGracefulShutdownRecoveryCredit({
      sql: fakeSql(result) as never,
      executorId: 'bg-host-3270',
      proc: proc as never,
      log,
      warn: vi.fn(),
    });

    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    await flush();

    expect(result).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('credited 1 in-flight workflow(s)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('wf-long'));
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('warns and leaves the attempt counted when the credit fails', async () => {
    const proc = fakeProc();
    proc.on('SIGTERM', () => {});
    const warn = vi.fn();
    armGracefulShutdownRecoveryCredit({
      sql: fakeSql(async () => {
        throw new Error('canceling statement due to statement timeout');
      }) as never,
      executorId: 'bg-host-3270',
      proc: proc as never,
      log: vi.fn(),
      warn,
    });

    proc.emit('SIGTERM');
    await flush();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('counts as a recovery attempt'));
  });

  it('re-raises the signal after the credit when it is the only listener', async () => {
    const proc = fakeProc();
    armGracefulShutdownRecoveryCredit({
      sql: fakeSql(async () => []) as never,
      executorId: 'bg-host-3270',
      proc: proc as never,
      log: vi.fn(),
      warn: vi.fn(),
    });

    proc.emit('SIGTERM');
    await flush();

    expect(proc.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('re-raises after a bounded wait even if the credit never settles', async () => {
    vi.useFakeTimers();
    const proc = fakeProc();
    armGracefulShutdownRecoveryCredit({
      sql: fakeSql(() => new Promise(() => {})) as never,
      executorId: 'bg-host-3270',
      proc: proc as never,
      log: vi.fn(),
      warn: vi.fn(),
    });

    proc.emit('SIGINT');
    expect(proc.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(GRACEFUL_RECOVERY_CREDIT_SOLE_LISTENER_EXIT_MS);
    expect(proc.kill).toHaveBeenCalledWith(4242, 'SIGINT');
  });

  it('disarm removes both listeners', () => {
    const proc = fakeProc();
    const disarm = armGracefulShutdownRecoveryCredit({
      sql: fakeSql(async () => []) as never,
      executorId: 'bg-host-3270',
      proc: proc as never,
    });
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    disarm();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});
