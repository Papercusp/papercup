/**
 * read-merge-stage-stall.test.ts — P-012 (fleet-reliability-verification-
 * 2026-07-10, named-hop pipeline observability): the merge pass's
 * `applyRecordingWinner` wraps `apply(env)` with the shared
 * `logIfStageStalls` (generalized out of `outbox-drain.ts`'s WI-3619 fix) so
 * a hung projection-apply — an unbounded PG write with the same hang shape
 * as the send-side drain's `append()` — NAMES ITSELF in the journal (scope =
 * source log key, stage = table::key) instead of the merge pass just going
 * silent. Pins: a still-pending `apply()` past the stall threshold logs the
 * named line; the merge pass itself is otherwise unaffected (this is an
 * observability side-channel, never a timeout).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import { STAGE_STALL_LOG_MS } from './stage-stall-log';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function put(hbKey: string, ts: number, value: unknown): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, schema_version: 1, author_pubkey: 'pk' };
}

describe('P-012 — merge-apply stage-stall naming', () => {
  it('a merge-apply that hangs past the threshold logs a line naming the source log key + table::key', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cursor = createMergeCursor();
      const log = memLog('deadbeef-source-log', [put('k1', 1000, { id: 'k1' })]);
      // apply() never resolves — models a wedged PG write (a stuck connection/lock).
      const apply = async (_op: OpEnvelope): Promise<boolean> => new Promise<boolean>(() => {});

      const mergePromise = mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: apply,
        getTimeoutMs: 0,
      });
      // Swallow the eventual unhandled-rejection-shaped never-settle — this
      // test only asserts the STALL LOG fires, not that the merge completes
      // (a genuinely hung apply never lets this pass settle in production
      // either; the pass-level watchdog belongs to the caller, mirroring
      // outbox-drain's DRAIN_PASS_TIMEOUT_MS).
      mergePromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS + 1);

      expect(errSpy).toHaveBeenCalledTimes(1);
      const [line] = errSpy.mock.calls[0];
      expect(line).toContain('STAGE STALL');
      expect(line).toContain('deadbeef-source-log'); // scope = the source log's key
      expect(line).toContain('merge-apply');
      expect(line).toContain('features-by-id::k1'); // stage names table::key
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a merge-apply that settles quickly never logs a stall', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cursor = createMergeCursor();
      const log = memLog('healthy-log', [put('k1', 1000, { id: 'k1' })]);
      const apply = async (_op: OpEnvelope): Promise<boolean> => true;

      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS + 1000);

      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
