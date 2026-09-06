import { describe, it, expect, vi } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  createMergeCursor,
} from '../read-merge';
import type { OwnLog, PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

/*
 * WI-255 UPDATE (2026-06-20, su-328af): the "self-heals via winners-dedup (no re-throw)"
 * behavior this test documented was ALSO the data-loss bug — the winner was recorded
 * BEFORE apply, so a VALID op whose apply threw transiently got dedup-skipped forever too,
 * not just a poison NUL. WI-255 recorded the winner only AFTER a non-throwing apply: a
 * poison op RE-THREW up to MAX_APPLY_THROWS then QUARANTINED (record+skip+log).
 *
 * F4 UPDATE (2026-09-05, read-merge `MergeApplyOutcome` / `applyFailures`): processing an
 * entry is now distinct from materializing it. A throwing apply no longer propagates out
 * of the merge and is NEVER quarantined: the outcome is `retryable`, the pass stops for
 * that log, the durable cursor is HELD at the failing position, and the failure is
 * recorded on `cursor.applyFailures` with a climbing `attempts` count. The entry's bytes
 * and every later entry stay in Hypercore behind the held cursor — retried every pass,
 * not lost, not skipped. Tests 1–2 below pin that contract (2026-09-06, su-d424fbb5, gate
 * fixer for WI-212675 — the prior WI-255 expectations went red at tip once F4 landed).
 * The Brief Z finding (poison NUL is never stored, identically on every peer → no
 * divergence) is unchanged. Full NUL-sanitization (the it.fails DESIRED) is still a
 * follow-up.
 */

/**
 * Brief Z (shared-pot-release-testing) — Z#4/Z#5: NUL-bearing federated op handling.
 *
 * FINDING (LOW severity — the severe "permanent poison-pill stall" hypothesis was
 * REFUTED by this test; recorded accurately):
 *
 * A federated op whose PG apply THROWS (e.g. a NUL 0x00 byte in a title/notes — PG
 * rejects it in TEXT and JSONB; nothing in the federation value path sanitizes it, and
 * projection.ts applyOpVia has no try/catch around the write) causes the incremental
 * merge to throw on the FIRST pass that reaches it (read-merge.ts ~L563 `await apply`
 * is not wrapped, and `cursor.positions` is only set after the per-op loop). BUT it is
 * NOT a permanent stall: `cursor.winners.set` records the op as the key's winner BEFORE
 * the apply (L~562), so on the NEXT pass the op matches the stale-dedup guard
 * (`if (prev && !beatsStored) continue`) and is SKIPPED without re-applying — the merge
 * self-heals and subsequent good ops apply.
 *
 * Net behavior: (a) one TRANSIENT throw per process lifetime that first reaches the op
 * (winners is in-memory → re-incurred once per restart), which also delays co-pass logs
 * by one pass; (b) the NUL op's content is never written — but PG fundamentally cannot
 * store a NUL, so EVERY peer drops it identically → no divergence. So this is a
 * robustness nit (avoidable transient error + log noise), not a correctness or liveness
 * S1. Recommendation: sanitize NUL at the value boundary, or wrap `apply` so a poison op
 * is skipped cleanly (recorded, no throw). Owner/lead's call; not applied here.
 *
 * PG-free + faithful: the applyImpl throws on a literal-NUL value exactly as the real PG
 * write would on `${row.title}` (detected by scanning string fields — NOT JSON.stringify,
 * which escapes the NUL to a 6-char sequence and would never match the real failure).
 */

const NUL = String.fromCharCode(0); // a literal NUL char at runtime; no special byte in source

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}

function memLog(keyHex: string): OwnLog {
  const ops: PeerLogOp[] = [];
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

/** True iff any (nested) string field holds a literal NUL — what PG rejects on bind. */
function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(NUL);
  if (value && typeof value === 'object') return Object.values(value).some(hasNul);
  return false;
}

/** applyImpl that throws on any put whose value carries a NUL (mimics PG's rejection). */
function pgLikeApply(pg: Map<string, unknown>) {
  return async (env: OpEnvelope) => {
    if (env.type === 'put' && hasNul(env.value)) {
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00'); // PG-shaped
    }
    const k = `${env.table}::${env.hbKey}`;
    if (env.type === 'del') pg.delete(k);
    else pg.set(k, env.value);
    return true;
  };
}

async function buildLog(): Promise<OwnLog> {
  const log = memLog('c0'.repeat(32));
  await log.append(put('queue', 'GOOD-1', { v: 'ok' }, 1));
  await log.append(put('queue', 'POISON', { title: 'bad' + NUL + 'title' }, 2)); // NUL in a field
  await log.append(put('queue', 'GOOD-2', { v: 'ok2' }, 3)); // after the poison
  return log;
}

const PASS = { getTimeoutMs: 0, maxOpsPerPass: 0 } as const;

describe('Brief Z Z#4/Z#5 — NUL-bearing federated op (transient throw, self-healing)', () => {
  it('first pass: a throwing apply is HELD, not thrown — the merge resolves, the cursor stops at the poison op, later ops wait behind it', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await mergeAdmittedLogsIncremental([log], cursor, { ...PASS, applyImpl: pgLikeApply(pg) });
    expect(result.applied).toBe(1); // GOOD-1 materialized
    expect(result.caughtUp).toBe(false); // the log is NOT caught up — the poison op is unresolved

    // The durable cursor is HELD at the poison op's position (1): GOOD-1 (0) applied, the
    // poison op and GOOD-2 remain in Hypercore behind the held cursor.
    expect(cursor.positions.get(log.keyHex)).toBe(1);
    expect(pg.has('queue::GOOD-1')).toBe(true);
    expect(pg.has('queue::POISON')).toBe(false); // NUL content never stored (PG can't anyway)
    expect(pg.has('queue::GOOD-2')).toBe(false); // waits behind the held cursor

    // The failure is RECORDED, not swallowed: first unresolved entry per log.
    const failure = cursor.applyFailures?.get(log.keyHex);
    expect(failure).toMatchObject({ position: 1, kind: 'retryable', attempts: 1 });
    expect(failure?.reason).toContain('invalid byte sequence');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('cursor HELD for replay'),
      expect.stringContaining('UTF8'),
    ); // logged on the first occurrence, not silent
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('every later pass retries the held entry in place: attempts climb, it is never quarantined and never lost, and later good ops stay behind it', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    const apply = pgLikeApply(pg);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const PASSES = 5;
    for (let i = 0; i < PASSES; i++) {
      // F4: a pass never throws — the failing entry is re-attempted from its held position.
      await mergeAdmittedLogsIncremental([log], cursor, { ...PASS, applyImpl: apply });
      expect(cursor.positions.get(log.keyHex)).toBe(1); // still held at the poison op
      expect(pg.has('queue::GOOD-2')).toBe(false); // still waiting behind it
    }
    const failure = cursor.applyFailures?.get(log.keyHex);
    expect(failure).toMatchObject({ position: 1, kind: 'retryable', attempts: PASSES });
    expect(failure?.firstSeenAt).toBeLessThanOrEqual(failure?.lastSeenAt ?? 0);

    // Never quarantined (no record+skip), never dropped: the poison op is still the first
    // unresolved entry and its content is still not stored.
    expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining('quarantine'), expect.anything());
    expect(pg.has('queue::POISON')).toBe(false); // consistent across peers — PG can't store it
    expect(pg.has('queue::GOOD-1')).toBe(true); // applied once on pass 1, deduped after
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  // The residual robustness gap: a NUL op SHOULD be sanitized/skipped cleanly so the ops
  // behind it are not held. it.fails because under F4 the poison op holds the cursor and
  // GOOD-2 never lands. Flip to `it` if NUL-sanitization / clean-skip handling lands.
  it.fails('DESIRED: a NUL-bearing op is skipped WITHOUT any throw (no transient error)', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([log], cursor, { ...PASS, applyImpl: pgLikeApply(pg) });
    expect(pg.has('queue::GOOD-1')).toBe(true);
    expect(pg.has('queue::GOOD-2')).toBe(true);
  });
});
