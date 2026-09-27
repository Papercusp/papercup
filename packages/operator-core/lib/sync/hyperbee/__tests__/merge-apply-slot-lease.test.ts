import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
  mergeApplyAdmissionSnapshot,
  DEFAULT_MERGE_APPLY_CONCURRENCY,
} from '../read-merge';
import type { OwnLog, PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/**
 * WI-10003427 — a physical write that never settles must not keep its PROCESS-WIDE
 * admission slot forever.
 *
 * Measured on the tower bg-host: postgres.js stranded statements on batch connections that
 * Postgres had killed for idle-in-transaction, so four merge applies never settled. Each held
 * one of the four process-wide slots until it settled, which was never, and every harness's
 * merge pass then parked on admission. Federation stopped fleet-wide while each harness's
 * health read looked fine.
 *
 * The contract pinned here: once a write outlives the apply timeout, its slot is released
 * (the write keeps running, counted as a zombie), and another harness's merge still applies.
 * Before the fix the fifth pass below waited on admission forever.
 */

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}

function memLog(keyHex: string, ops: PeerLogOp[]): OwnLog {
  return {
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(op: PeerLogOp) {
      ops.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      ops.push(...batch);
    },
    async get(i: number) {
      return ops[i] ?? null;
    },
  };
}

const APPLY_TIMEOUT_MS = 40;
const PASS = { getTimeoutMs: 0, maxOpsPerPass: 0, applyTimeoutMs: APPLY_TIMEOUT_MS } as const;

/** Resolves `p`, or rejects if it is still pending after `ms` — the test's own hang guard. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe('WI-10003427 merge-apply slot lease', () => {
  const releaseHung: Array<() => void> = [];
  afterEach(() => {
    // Let the hung writes settle so the process-wide gate is clean for the next file.
    for (const release of releaseHung.splice(0)) release();
    vi.restoreAllMocks();
  });

  it('releases the slot of a write that outlives the apply timeout, so other harnesses keep merging', async () => {
    // The held-cursor warnings and the zombie alarm are the expected, asserted output here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = mergeApplyAdmissionSnapshot();
    // One more hung write than there are slots: pre-fix, these alone froze the gate.
    const hungCount = DEFAULT_MERGE_APPLY_CONCURRENCY + 1;
    const hungApply = async (_env: OpEnvelope): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        releaseHung.push(() => resolve(true));
      });

    for (let i = 0; i < hungCount; i++) {
      const log = memLog(`a${i}`.padEnd(64, '0'), [put('queue', `HUNG-${i}`, { v: i }, i + 1)]);
      const cursor = createMergeCursor();
      // Each pass must SETTLE (holding its cursor) rather than wait on the hung write or on admission.
      await within(
        mergeAdmittedLogsIncremental([log], cursor, { ...PASS, applyImpl: hungApply }),
        2_000,
        `pass over hung log ${i}`,
      );
      expect(cursor.applyFailures?.get(log.keyHex)?.kind).toBe('retryable');
    }

    const during = mergeApplyAdmissionSnapshot();
    expect(during.zombiesTotal - before.zombiesTotal).toBeGreaterThanOrEqual(hungCount - 1);
    expect(during.inFlight).toBeLessThan(DEFAULT_MERGE_APPLY_CONCURRENCY);
    // The detach is loud: an operator reading the journal sees which write outlived its lease.
    expect(error.mock.calls.some((c) => String(c[0]).includes('MERGE-APPLY ZOMBIE: queue::HUNG-'))).toBe(true);

    // A different harness's healthy log still applies: the gate is not frozen.
    const applied: string[] = [];
    const goodLog = memLog('b'.repeat(64), [put('queue', 'GOOD', { v: 'ok' }, 1)]);
    const goodCursor = createMergeCursor();
    await within(
      mergeAdmittedLogsIncremental([goodLog], goodCursor, {
        ...PASS,
        applyImpl: async (env) => {
          applied.push(String(env.hbKey));
          return true;
        },
      }),
      2_000,
      'pass over the healthy log',
    );
    expect(applied).toEqual(['GOOD']);

    // Zombies are counted until their write settles, then released from the count.
    for (const release of releaseHung.splice(0)) release();
    await new Promise((r) => setTimeout(r, 10));
    expect(mergeApplyAdmissionSnapshot().zombies).toBe(before.zombies);
  });

  it('keeps the slot of a write that settles in time (no zombie for a merely-slow write)', async () => {
    const before = mergeApplyAdmissionSnapshot();
    const log = memLog('c'.repeat(64), [put('queue', 'SLOWISH', { v: 1 }, 1)]);
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([log], cursor, {
      ...PASS,
      applyImpl: async () => {
        await new Promise((r) => setTimeout(r, APPLY_TIMEOUT_MS / 4));
        return true;
      },
    });
    expect(cursor.applyFailures?.get(log.keyHex)).toBeUndefined();
    expect(mergeApplyAdmissionSnapshot().zombiesTotal).toBe(before.zombiesTotal);
  });
});
