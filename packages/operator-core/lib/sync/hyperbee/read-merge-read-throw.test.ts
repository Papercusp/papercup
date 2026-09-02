/**
 * read-merge-read-throw.test.ts — WI-2003: the incremental merge must not let a
 * PERMANENTLY-unreadable position (a REJECTED `log.get(i)` — e.g. a hypercore /
 * signature verify failure during identity divergence) wedge every SUBSEQUENT
 * op in that peer's strictly-sequential, single-writer log forever.
 *
 * THE BUG (pre-WI-2003): `readOpBoundedDetailed`'s own try/catch collapsed EVERY
 * thrown/rejected `log.get(i)` into the SAME `{ kind: 'unavailable' }` bucket as
 * a genuinely TRANSIENT timeout (peer offline / block not yet downloaded). Both
 * cases `break` the inner read loop without advancing `cursor.positions` — so a
 * PERMANENTLY-rejecting position (identity divergence poisoning one wrapped key,
 * per the ticket's repro) wedged the fold at that position FOREVER: not just that
 * one op skipped, every op after it in the same peer's log never folded either
 * (the "silent REV fed_event outage class").
 *
 * THE FIX: `readOpBoundedDetailed` now distinguishes a REJECTED read (new
 * `{ kind: 'read-error' }`) from a genuine timeout race (`{ kind: 'unavailable' }`,
 * unchanged — still unbounded retry-via-break, since that IS often transient). A
 * `read-error` is retried up to `MAX_READ_THROWS` times (in case it clears — e.g.
 * a race with identity repair), then DEAD-LETTERED: the position is skipped (like
 * a version-gated drop) so the REST of the log keeps folding, with a quarantine
 * log naming the position for observability/paging.
 *
 * TEETH: without the fix, ops after the poisoned position never fold (the merge
 * `break`s at the same position every pass, forever) — this test asserts they DO
 * fold, within a bounded number of passes, and that the quarantine is logged.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function put(hbKey: string, ts: number, value: unknown): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, schema_version: 1, author_pubkey: 'pk' };
}
const KEY = (hbKey: string) => `features-by-id::${hbKey}`;

/** A log whose `get(poisonIndex)` ALWAYS rejects (models a permanently-
 *  unverifiable block — e.g. a signature check failing under identity
 *  divergence), while every other index resolves normally. */
function logWithPoisonedIndex(keyHex: string, ops: PeerLogOp[], poisonIndex: number): AdmittedLog {
  return {
    keyHex,
    length: ops.length,
    get: async (i) => {
      if (i === poisonIndex) throw new Error('could not verify data');
      return ops[i] ?? null;
    },
  };
}

describe('WI-2003 — incremental merge read-throw recovery (no permanent wedge)', () => {
  it('a PERMANENTLY-unreadable position is dead-lettered after MAX_READ_THROWS — ops AFTER it still fold (no forever-wedge)', async () => {
    const cursor = createMergeCursor();
    // index0 'a' (normal) → index1 'poison' (get() always throws) → index2 'c' (normal).
    const log = logWithPoisonedIndex(
      'A',
      [put('a', 1000, {}), put('poison', 2000, {}), put('c', 3000, {})],
      1,
    );
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(op.hbKey ?? '');
      return true;
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Pre-fix behavior: the merge would `break` at index1 EVERY pass, forever —
    // 'c' (index2) would never fold no matter how many passes are run. Run a
    // BOUNDED number of passes and assert convergence.
    let passes = 0;
    while (cursor.positions.get('A') !== 3 && passes < 8) {
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
      passes++;
    }

    expect(cursor.positions.get('A')).toBe(3); // BOUNDED convergence — never a forever-wedge
    expect(passes).toBeLessThanOrEqual(3); // MAX_READ_THROWS-bounded (default 3)

    // 'a' (before the poison) and 'c' (AFTER the poison) both folded — the poison
    // position did not stop the REST of the log from folding.
    expect(applied).toContain('a');
    expect(applied).toContain('c');
    expect(applied).not.toContain('poison'); // the poisoned op itself is never applied
    expect(cursor.winners.has(KEY('c'))).toBe(true);
    expect(cursor.winners.has(KEY('poison'))).toBe(false); // dead-lettered, not recorded as a winner

    // The quarantine was logged (observable / pageable), not a silent skip.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('WI-2003 quarantine'),
      expect.stringContaining('could not verify data'),
    );
    errSpy.mockRestore();
  });

  it('a TRANSIENT read failure that clears within MAX_READ_THROWS retries is NOT dead-lettered — the op eventually folds normally', async () => {
    const cursor = createMergeCursor();
    let failuresLeft = 1; // fails once, then succeeds — models a genuinely transient blip
    const log: AdmittedLog = {
      keyHex: 'A',
      length: 1,
      get: async (i) => {
        if (i === 0 && failuresLeft > 0) {
          failuresLeft--;
          throw new Error('transient read blip');
        }
        return put('k1', 1000, {});
      },
    };
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(op.hbKey ?? '');
      return true;
    };

    // Pass 1: read throws once → bounded retry (break, no dead-letter yet).
    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(cursor.positions.get('A') ?? 0).toBe(0); // not yet advanced
    expect(applied).toEqual([]);

    // Pass 2: the transient failure has cleared → reads + applies normally, exactly
    // like the pre-existing op-throw-recovery contract on the apply side (WI-255).
    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(applied).toEqual(['k1']);
    expect(cursor.positions.get('A')).toBe(1);
    expect(cursor.winners.has(KEY('k1'))).toBe(true);
  });

  it('an "unavailable" (timeout) read is UNCHANGED — still unbounded retry-via-break, never dead-lettered', async () => {
    const cursor = createMergeCursor();
    // get() never resolves within the (tiny, real) timeout — models a peer that
    // hasn't sent the block yet, NOT a rejection.
    const log: AdmittedLog = {
      keyHex: 'A',
      length: 1,
      get: () => new Promise<PeerLogOp | null>(() => {}), // never resolves
    };
    const apply = async (_op: OpEnvelope): Promise<boolean> => true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // WI-2141796: the retry semantics below are UNCHANGED, but the stall is no
    // longer silent — it now warns (throttled). Mocked so the console guard does
    // not fail the run, and asserted below so the two contracts stay distinct.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Several passes with a real (tiny) timeout — must stay at position 0 forever
    // (unavailable ops are NEVER dead-lettered, unlike read-errors) and must NOT
    // log a WI-2003 quarantine (that codepath is read-error-only).
    for (let i = 0; i < 4; i++) {
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 5 });
    }
    expect(cursor.positions.get('A') ?? 0).toBe(0);
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('WI-2003 quarantine'), expect.anything());
    // WI-2141796: an unavailable read is REPORTED (throttled on a doubling
    // schedule — 4 passes announce at 1,2,4) and counted every pass. The retry
    // stayed unbounded; it just stopped being invisible. Asserted as a RANGE
    // because this test's contract is "the stall is reported and not quarantined",
    // not the throttle schedule itself — that is pinned in
    // read-merge-read-stall.test.ts, which is where a schedule change should fail.
    const stallLines = warnSpy.mock.calls.filter((c) => String(c[0]).includes('read stall'));
    expect(stallLines.length).toBeGreaterThan(0);
    expect(stallLines.length).toBeLessThanOrEqual(4);
    expect(cursor.readStalls?.get('A:0')).toBe(4);
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
