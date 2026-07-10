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
 * not just a poison NUL. WI-255 records the winner only AFTER a non-throwing apply: a
 * poison op now RE-THROWS up to MAX_APPLY_THROWS (a valid transient recovers in that
 * window) then QUARANTINES (record+skip+log), instead of an immediate silent dedup-skip.
 * Test 2 below is updated to that behavior; the Brief Z finding (poison NUL is dropped
 * consistently across peers → no divergence) is unchanged — only the mechanism (bounded
 * retry→quarantine, not dedup-before-apply) changed. Full NUL-sanitization (zero throws,
 * the it.fails DESIRED) is still a follow-up.
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
  it('first pass: a throwing apply propagates out of the merge (uncaught — the transient error)', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    await expect(
      mergeAdmittedLogsIncremental([log], cursor, { ...PASS, applyImpl: pgLikeApply(pg) }),
    ).rejects.toThrow(/invalid byte sequence/);
    // The cursor did not advance past the poison op this pass; GOOD-2 not yet applied.
    expect(cursor.positions.get(log.keyHex) ?? 0).toBeLessThanOrEqual(1);
    expect(pg.has('queue::GOOD-1')).toBe(true);
    expect(pg.has('queue::GOOD-2')).toBe(false);
  });

  it('self-heals via BOUNDED retry → quarantine (WI-255): the poison op re-throws then quarantines, and later good ops apply', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    const apply = pgLikeApply(pg);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // WI-255: the winner is NOT recorded after a throw, so the poison op RE-THROWS each
    // pass (a valid transient would recover in this window — that's the fixed data loss)
    // until the bounded retry budget QUARANTINES it; later passes converge. Run to settle.
    let throwingPasses = 0;
    let settled = false;
    for (let i = 0; i < 8 && !settled; i++) {
      try {
        await mergeAdmittedLogsIncremental([log], cursor, { ...PASS, applyImpl: apply });
        settled = true;
      } catch {
        throwingPasses++;
      }
    }
    expect(settled).toBe(true); // BOUNDED — never an infinite retry loop
    expect(throwingPasses).toBeGreaterThanOrEqual(1); // it DID re-throw (not silently dedup-skipped — the bug)
    expect(throwingPasses).toBeLessThanOrEqual(3); // MAX_APPLY_THROWS-bounded
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('WI-255 quarantine'),
      expect.stringContaining('UTF8'),
    ); // quarantine logged, not silent
    errSpy.mockRestore();

    expect(pg.has('queue::GOOD-2')).toBe(true); // recovered — later good ops apply
    expect(pg.has('queue::POISON')).toBe(false); // NUL content never stored (PG can't anyway) — consistent across peers
    expect(cursor.positions.get(log.keyHex) ?? 0).toBe(log.length); // caught up
  });

  // The residual robustness gap: a NUL op SHOULD be skipped cleanly with no throw at all
  // (no transient error / log noise / one-pass co-log delay). it.fails because pass 1
  // still throws today. Flip to `it` if NUL-sanitization / clean-skip handling lands.
  it.fails('DESIRED: a NUL-bearing op is skipped WITHOUT any throw (no transient error)', async () => {
    const log = await buildLog();
    const pg = new Map<string, unknown>();
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([log], cursor, { ...PASS, applyImpl: pgLikeApply(pg) });
    expect(pg.has('queue::GOOD-1')).toBe(true);
    expect(pg.has('queue::GOOD-2')).toBe(true);
  });
});
