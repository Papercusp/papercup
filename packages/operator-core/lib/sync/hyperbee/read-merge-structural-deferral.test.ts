/**
 * read-merge-structural-deferral.test.ts — WI-559 / EI-18775450536624845.
 *
 * THE INCIDENT. A joiner's local Pot handle differed from the owner's announced
 * slug, so `pot_members` had no FK parent under the federated scope its projections
 * write to. Every inbound roster op raised PG `23503 foreign_key_violation`, and the
 * two pre-existing branches of `applyRecordingWinner` BOTH mishandled it:
 *   1. below MAX_APPLY_THROWS the throw PROPAGATED, aborting the whole merge pass
 *      every ~60s — so the log never advanced (writer at 7944, merged to 0), and no
 *      LATER op in the pass could land either;
 *   2. at MAX_APPLY_THROWS it QUARANTINED — winner recorded, op dropped — turning a
 *      self-healing structural mismatch into PERMANENT loss (~20 roster ops in 3
 *      minutes on the live rig). The roster stayed empty; the joiner admitted nobody.
 *
 * A structural failure is the OPPOSITE of poison: poison is a value PG can never
 * store; this op is perfectly storable and merely EARLY. So it needs a THIRD outcome
 * — skip without recording a winner, let the pass continue, re-apply later by itself.
 *
 * TEETH: every test here fails under the pre-fix code — test 1 because the pass
 * rejected, tests 2/3 because the op was quarantined (winner recorded) and therefore
 * never re-applied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMergeCursor,
  dependencyRetryDelayMs,
  mergeAdmittedLogsIncremental,
  MERGE_DEPENDENCY_RETRY_BASE_MS,
  MERGE_DEPENDENCY_RETRY_MAX_MS,
  rewindMergeCursor,
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

/** A `postgres`-library FK violation: the discriminator is `.code === '23503'`. */
function fkViolation(): Error & { code: string } {
  return Object.assign(
    new Error(
      'insert or update on table "pot_members" violates foreign key constraint "pot_members_pot_fkey"',
    ),
    { code: '23503' },
  );
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The poison test below deliberately drives the WI-255 quarantine, which logs.
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe('WI-559 — a STRUCTURAL apply failure defers, it does not abort or drop', () => {
  it('does NOT abort the merge pass — a later op in the SAME pass still lands', async () => {
    const cursor = createMergeCursor();
    // k1 has no FK parent yet; k2 is unrelated and perfectly appliable. Pre-fix, k1's
    // throw propagated and k2 never got a chance.
    const log = memLog('A', [put('k1', 1000, { id: 'k1' }), put('k2', 1001, { id: 'k2' })]);
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      if (op.hbKey === 'k1') throw fkViolation();
      applied.push(op.hbKey ?? '');
      return true;
    };

    await expect(
      mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 }),
    ).resolves.toBeDefined();

    expect(applied).toEqual(['k2']);
  });

  it('does NOT record a winner for the deferred op — so it stays eligible to re-apply', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);
    const apply = async (_op: OpEnvelope): Promise<boolean> => {
      throw fkViolation();
    };

    const result = await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });

    // The whole point: a recorded winner is what permanently drops an op, because
    // `beatsStored` then refuses to re-select it.
    expect(cursor.winners.has(KEY('k1'))).toBe(false);
    expect(result.caughtUp).toBe(false);
    expect(cursor.applyFailures?.get('A')).toMatchObject({ position: 0, kind: 'dependency-waiting', errorCode: '23503' });
  });

  it('SELF-HEALS: the same op applies once the missing referent lands — no re-fold, no operator action', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const cursor = createMergeCursor();
      const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);
      const applied: string[] = [];
      let parentExists = false;
      const apply = async (op: OpEnvelope): Promise<boolean> => {
        if (!parentExists) throw fkViolation();
        applied.push(op.hbKey ?? '');
        return true;
      };

      // Passes while the FK parent is missing: deferred every time, never dropped.
      for (let i = 0; i < 5; i++) {
        await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
        now += MERGE_DEPENDENCY_RETRY_MAX_MS;
      }
      expect(applied).toEqual([]);
      expect(cursor.winners.has(KEY('k1'))).toBe(false);

      // The repair lands (migration 686 + the canonical-slug reconcile). WI-10003506: the
      // re-attempt happens once the op's backoff window has passed, at most
      // MERGE_DEPENDENCY_RETRY_MAX_MS after the parent arrives.
      parentExists = true;
      now += MERGE_DEPENDENCY_RETRY_MAX_MS;
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });

      expect(applied).toEqual(['k1']);
      expect(cursor.winners.has(KEY('k1'))).toBe(true);
      expect(cursor.applyDeferrals?.size ?? 0).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('rate-limits the deferral log so a whole-Pot mismatch cannot flood the journal', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);
    const apply = async (_op: OpEnvelope): Promise<boolean> => {
      throw fkViolation();
    };

    for (let i = 0; i < 12; i++) {
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    }

    // First occurrence only (then every 100th) — not one line per pass.
    const deferralLogs = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('structural apply deferral'),
    );
    expect(deferralLogs).toHaveLength(1);
  });

  it('retains an explicit permanent rejection as a dead letter while later valid rows apply', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k1', 1000, { id: 'poison' }), put('k2', 1001, {})]);
    const apply = vi.fn(async (op: OpEnvelope) => op.hbKey === 'k1'
      ? { kind: 'rejected' as const, reason: 'schema rejects this value', errorCode: 'invalid-value' }
      : { kind: 'applied' as const, changed: true });

    // Enough passes to exhaust MAX_APPLY_THROWS; a non-structural throw still
    // propagates until it quarantines, at which point the winner IS recorded.
    for (let i = 0; i < 10; i++) {
      await mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: apply,
        getTimeoutMs: 0,
      });
    }
    expect(cursor.winners.has(KEY('k1'))).toBe(false);
    expect(cursor.winners.has(KEY('k2'))).toBe(true);
    expect(cursor.positions.get('A')).toBe(0);
    expect(cursor.applyFailures?.get('A')).toMatchObject({ position: 0, kind: 'rejected', errorCode: 'invalid-value' });
  });
});

/**
 * WI-10003506 — measured on the P-203 VM: 36 held structural deferrals, all in one peer
 * log, were re-run against PG on every merge pass (about 0.7/s), about 26 FK failures/s. PG logged
 * each with its full statement, about 4.4 MB/min, on a disk already 98% full. The per-op log
 * throttle above could not help, because the volume was PG's own log.
 *
 * TEETH: under the pre-fix code every pass re-runs the write, so the call counts below are
 * one per pass, not one per backoff window.
 */
describe('WI-10003506 — a held structural deferral backs off instead of hammering PG every pass', () => {
  let now = 0;
  let clock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    now = 5_000_000;
    clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => clock.mockRestore());

  const alwaysFk = () => vi.fn(async (_op: OpEnvelope): Promise<boolean> => {
    throw fkViolation();
  });

  it('back-to-back passes inside the window attempt the held op ONCE', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);
    const apply = alwaysFk();

    for (let i = 0; i < 20; i++) {
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    }

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a skipped pass still HOLDS the op: no winner, cursor held, the real failure record kept', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);
    const apply = alwaysFk();

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    const skipped = await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(skipped.caughtUp).toBe(false);
    expect(cursor.winners.has(KEY('k1'))).toBe(false);
    expect(cursor.positions.get('A') ?? 0).toBe(0);
    expect(cursor.applyFailures?.get('A')).toMatchObject({ position: 0, kind: 'dependency-waiting', errorCode: '23503' });
  });

  it('later ops in the same log keep applying while the held op backs off', async () => {
    const cursor = createMergeCursor();
    const ops = [put('k1', 1000, { id: 'k1' }), put('k2', 1001, { id: 'k2' })];
    let visible = 1;
    const log: AdmittedLog = {
      keyHex: 'A',
      get length() {
        return visible;
      },
      get: async (i) => ops[i] ?? null,
    };
    const applied: string[] = [];
    const apply = vi.fn(async (op: OpEnvelope): Promise<boolean> => {
      if (op.hbKey === 'k1') throw fkViolation();
      applied.push(op.hbKey ?? '');
      return true;
    });

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    visible = 2; // k2 arrives while k1 is inside its window
    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });

    expect(applied).toEqual(['k2']);
    expect(apply.mock.calls.filter(([op]) => op.hbKey === 'k1')).toHaveLength(1);
  });

  it('re-attempts once the window passes, and the window doubles up to the cap', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);
    const apply = alwaysFk();
    const pass = () => mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });

    await pass(); // attempt 1 → next after BASE
    now += MERGE_DEPENDENCY_RETRY_BASE_MS - 1;
    await pass();
    expect(apply).toHaveBeenCalledTimes(1);
    now += 1;
    await pass(); // attempt 2 → next after 2×BASE
    expect(apply).toHaveBeenCalledTimes(2);
    now += MERGE_DEPENDENCY_RETRY_BASE_MS;
    await pass();
    expect(apply).toHaveBeenCalledTimes(2);
    now += MERGE_DEPENDENCY_RETRY_BASE_MS;
    await pass();
    expect(apply).toHaveBeenCalledTimes(3);

    // Far past any window: exactly one attempt per pass that lands after its window.
    for (let i = 0; i < 10; i++) {
      now += MERGE_DEPENDENCY_RETRY_MAX_MS;
      await pass();
    }
    expect(apply).toHaveBeenCalledTimes(13);
    const deferral = [...(cursor.applyDeferrals?.values() ?? [])][0];
    expect(deferral.retryAt - now).toBe(MERGE_DEPENDENCY_RETRY_MAX_MS);
  });

  it('a rewind drops the backoff, so the re-read op is re-attempted at once', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k0', 999, { id: 'k0' }), put('k1', 1000, { id: 'k1' })]);
    const apply = vi.fn(async (op: OpEnvelope): Promise<boolean> => {
      if (op.hbKey === 'k1') throw fkViolation();
      return true;
    });

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(cursor.applyDeferrals?.size).toBe(1);
    expect(rewindMergeCursor(cursor, new Map([['A', 0]]))).toEqual(['A']);
    expect(cursor.applyDeferrals?.size).toBe(0);

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(apply.mock.calls.filter(([op]) => op.hbKey === 'k1')).toHaveLength(2);
  });

  it('dependencyRetryDelayMs grows exponentially from BASE and caps at MAX', () => {
    expect(dependencyRetryDelayMs(1)).toBe(MERGE_DEPENDENCY_RETRY_BASE_MS);
    expect(dependencyRetryDelayMs(2)).toBe(2 * MERGE_DEPENDENCY_RETRY_BASE_MS);
    expect(dependencyRetryDelayMs(3)).toBe(4 * MERGE_DEPENDENCY_RETRY_BASE_MS);
    expect(dependencyRetryDelayMs(1_000_000)).toBe(MERGE_DEPENDENCY_RETRY_MAX_MS);
    expect(dependencyRetryDelayMs(0)).toBe(MERGE_DEPENDENCY_RETRY_BASE_MS);
  });
});
