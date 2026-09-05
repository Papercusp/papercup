/**
 * read-merge-apply-timeout.test.ts — WI-3896 (tower outbox/merge wedge: "papercusp
 * substrate_merge_cursor never establishes"): a HUNG (never resolving, never
 * throwing) `apply(env)` used to freeze `mergeAdmittedLogsIncremental` FOREVER —
 * unlike `outbox-drain.ts`'s send-side pass, which already races the whole pass
 * against `DRAIN_PASS_TIMEOUT_MS`, nothing bounded this per-op await (the
 * `read-merge-stage-stall.test.ts` docstring explicitly called this out:
 * `logIfStageStalls` only LOGS at 15s, it never times out `p`). The live incident:
 * an old iMac device's stale plan-parts (~ef7a8160) hung merge-apply forever, so
 * the harness's PG-persisted merge cursor simply stopped advancing, silently.
 *
 * F4: the timeout bounds a pass, not data durability. A never-settling write is
 * retained behind the cursor and its promise reused. Other logs still progress.
 * Test 2 pins that a merely-SLOW (but eventually successful) apply
 * is NOT mistaken for poison — it applies normally once the retry gives it
 * enough real time; test 3 pins `applyTimeoutMs: 0` fully disables the bound
 * (today's pre-WI-3896 behavior, preserved as an explicit opt-out).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createMergeCursor,
  DEFAULT_MERGE_APPLY_CONCURRENCY,
  mergeAdmittedLogsIncremental,
  type AdmittedLog,
} from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function put(hbKey: string, ts: number, value: unknown): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, schema_version: 1, author_pubkey: 'pk' };
}
const KEY = (hbKey: string) => `features-by-id::${hbKey}`;
afterEach(() => vi.restoreAllMocks());

describe('WI-3896 — incremental merge apply-TIMEOUT recovery (bounded hang, no permanent wedge)', () => {
  it('a never-settling apply stays recoverable without repeated writes or blocking other logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cursor = createMergeCursor();
    const poison = memLog('A', [put('k1', 1000, { id: 'ef7a8160-stale-plan-part' })]);
    // Models the live incident: apply() never resolves, never rejects (a wedged
    // connection/lock against a stale/dead device's row).
    let finish!: (value: boolean) => void;
    const hung = new Promise<boolean>((resolve) => { finish = resolve; });
    const apply = vi.fn(async (op: OpEnvelope): Promise<boolean> => op.hbKey === 'k1' ? hung : true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const healthy = memLog('B', [put('k2', 1001, {})]);
    for (let i = 0; i < 5; i++) {
        const result = await mergeAdmittedLogsIncremental([poison, healthy], cursor, {
          applyImpl: apply,
          getTimeoutMs: 0,
          applyTimeoutMs: 10,
        });
        expect(result.caughtUp).toBe(false);
    }
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('UNAPPLIED BACKLOG'),
      expect.stringContaining('TIMEOUT'),
    );
    errSpy.mockRestore();

    expect(cursor.winners.has(KEY('k1'))).toBe(false);
    expect(cursor.positions.get('A')).toBe(0);
    expect(cursor.positions.get('B')).toBe(1);
    expect(cursor.applyFailures?.get('A')).toMatchObject({ position: 0, kind: 'retryable', attempts: 5 });
    expect(apply.mock.calls.filter(([op]) => op.hbKey === 'k1')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    finish(true); // teardown the otherwise never-settling stage timer.
    await hung;
  });

  it('a SLOW-but-eventually-successful apply is NOT mistaken for poison — it lands once it gets enough real time', async () => {
    const cursor = createMergeCursor();
    const applied: string[] = [];
    // Resolves after a short real delay — comfortably under the bound — modeling
    // a legitimately slow write under host load, not a genuine wedge.
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 5));
      applied.push(op.hbKey ?? '');
      return true;
    };
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);

    const result = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
      applyTimeoutMs: 500, // generous relative to the 5ms write
    });

    expect(result.applied).toBe(1);
    expect(applied).toEqual(['k1']);
    expect(cursor.winners.has(KEY('k1'))).toBe(true);
  });

  it('applyTimeoutMs: 0 disables the bound entirely (explicit opt-out, pre-WI-3896 behavior)', async () => {
    const cursor = createMergeCursor();
    const applied: string[] = [];
    // Resolves, but only after longer than what would otherwise be the default
    // bound — proves 0 truly disables it rather than just using a big number.
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 20));
      applied.push(op.hbKey ?? '');
      return true;
    };
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);

    const result = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
      applyTimeoutMs: 0,
    });

    expect(result.applied).toBe(1);
    expect(applied).toEqual(['k1']);
  });

  it('bounds physical projection writes across concurrent harness merge loops', async () => {
    const callers = DEFAULT_MERGE_APPLY_CONCURRENCY + 1;
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const apply = vi.fn(async (): Promise<boolean> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return true;
    });

    const merges = Array.from({ length: callers }, (_, i) =>
      mergeAdmittedLogsIncremental(
        [memLog(`log-${i}`, [put(`k-${i}`, 1000 + i, { id: `k-${i}` })])],
        createMergeCursor(),
        { applyImpl: apply, getTimeoutMs: 0, applyTimeoutMs: 5_000 },
      ),
    );

    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(DEFAULT_MERGE_APPLY_CONCURRENCY));
    expect(maxActive).toBe(DEFAULT_MERGE_APPLY_CONCURRENCY);

    releases.shift()!();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(callers));
    while (releases.length > 0) releases.shift()!();

    const results = await Promise.all(merges);
    expect(results.every((result) => result.applied === 1)).toBe(true);
    expect(maxActive).toBe(DEFAULT_MERGE_APPLY_CONCURRENCY);
  });
});
