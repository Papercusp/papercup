/**
 * lww-hlc-fedts-divergence.test.ts — Brief D (shared-hive-release-testing),
 * finding D-001. PROVES that the 2026-06-14 HLC/fed_ts convergence fix
 * (agent-insights/hlc-merge-vs-fed-ts-guard-divergence) is INCOMPLETE: two
 * honest peers still converge their in-memory winner-fold to the SAME op yet
 * MATERIALISE DIFFERENT rows for the same key — a silent split-brain — whenever
 * the merge's HLC order disagrees with the projection's PG `fed_ts` order.
 *
 * The two ordering decisions a federated write passes through:
 *   1. merge winners-fold  (read-merge `beatsStored` ≡ `lwwPick`) — orders by HLC
 *   2. PG projection guard  (`WHERE EXCLUDED.fed_ts >= stored.fed_ts`)  — orders by fed_ts
 *
 * The 2026-06-14 fix seeds the HLC's physical component from the op's own
 * write-time `ts` (`stampOpHlc`: `encodeHlc(clock.now(op.ts))`) so HLC ≥ ts for
 * the SAME op. But `HlcClock.send(ts)` returns `max(clock.physical, ts)`, and
 * the RECV seam (`observeRemoteHlc`/`clock.recv`) — which the fix DELIBERATELY
 * preserves — advances `clock.physical` ABOVE a later write's `ts`. So a peer
 * that has observed a high-HLC remote op then writes a key with a lower wall
 * `ts` stamps it HLC-physical > ts: HLC order and fed_ts order DECOUPLE again.
 *
 * This test reproduces that with the REAL merge (`mergeAdmittedLogsIncremental`
 * + the real `beatsStored`/`lwwPick`), the REAL `stampOpHlc`/`HlcClock` seams,
 * and a faithful in-memory transcription of the projection's PG `fed_ts` guard
 * (`EXCLUDED.fed_ts >= stored.fed_ts` — identical across all 18 mutable
 * projections). The Docker/real-PG twin is
 * `lww-hlc-fedts-divergence.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { HlcClock } from '@papercusp/locks-core';
import { stampOpHlc } from '../hlc-stamp';
import { lwwPick } from '../projection';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

const TABLE = 'features-by-id';
const KEY = 'F-contested';

/** A single-op in-memory AdmittedLog (the merge only needs keyHex/length/get). */
function singleOpLog(keyHex: string, op: PeerLogOp): AdmittedLog {
  return { keyHex, length: 1, get: async (i) => (i === 0 ? op : null) };
}

/**
 * A faithful in-memory transcription of EVERY mutable projection's PG LWW
 * guard: `INSERT … ON CONFLICT … WHERE stored.fed_ts IS NULL OR
 * EXCLUDED.fed_ts >= stored.fed_ts`, with `fed_ts = provenance.ts = op.ts`
 * (projection.ts:249,255 → harness-features.ts:140 + the identical line in all
 * 17 sibling projections). Returns whether the row was (re)written — same
 * boolean the real `applyOpVia` returns.
 */
class FedTsGuardedStore {
  readonly rows = new Map<string, { fedTs: number | null; value: unknown }>();
  apply = async (op: OpEnvelope): Promise<boolean> => {
    if (op.type !== 'put' || !op.hbKey) return false;
    const incoming = op.ts ?? null; // fed_ts = provenance.ts = op.ts
    const cur = this.rows.get(op.hbKey);
    // Guard: applies iff no stored row, stored fed_ts is NULL, or incoming >= stored.
    if (cur && cur.fedTs !== null && (incoming === null || incoming < cur.fedTs)) {
      return false; // strictly-older op rejected — the row is NOT clobbered
    }
    this.rows.set(op.hbKey, { fedTs: incoming, value: op.value });
    return true;
  };
  marker(key: string): string | undefined {
    return (this.rows.get(key)?.value as { marker?: string } | undefined)?.marker;
  }
}

/** Build a feature `put` PeerLogOp, HLC-stamped through the REAL send seam on
 *  `clock` (so its HLC physical = max(clock.physical, ts) exactly as production). */
function stampedPut(opts: { marker: string; ts: number; clock: HlcClock }): PeerLogOp {
  const base: PeerLogOp = {
    type: 'put',
    table: TABLE,
    hbKey: KEY,
    value: { marker: opts.marker, ts: opts.ts },
    ts: opts.ts,
    schema_version: 1,
    author_pubkey: `pk-${opts.marker}`,
  };
  return stampOpHlc(base, opts.clock);
}

/** Run the REAL incremental merge of two logs in a given order into a fresh
 *  fed_ts-guarded store, and return the store's converged value for KEY. */
async function mergeInto(logs: AdmittedLog[]): Promise<FedTsGuardedStore> {
  const store = new FedTsGuardedStore();
  const cursor = createMergeCursor();
  // Two passes — idempotent; the second proves quiescence (applies nothing new).
  await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: store.apply, getTimeoutMs: 0 });
  await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: store.apply, getTimeoutMs: 0 });
  return store;
}

describe('D-001 — HLC-merge vs fed_ts-guard divergence (recv-advance trigger)', () => {
  /**
   * Construct the inversion via the REAL seams:
   *   - winner W: its author observed a remote op at HLC.physical=9000 (recv
   *     advance), then writes KEY at wall ts=1000 → HLC=(9000,·), fed_ts=1000.
   *   - loser  L: a fresh clock, writes KEY at wall ts=5000 → HLC=(5000,0), fed_ts=5000.
   * So HLC_W > HLC_L (W wins the merge fold) but fed_ts_W < fed_ts_L (the PG
   * guard prefers L). The two ordering keys disagree.
   */
  function buildInvertedPair(): { opW: PeerLogOp; opL: PeerLogOp } {
    const clockW = new HlcClock({ physical: () => 1000 }); // W's wall clock at 1000
    clockW.recv({ ms: 9000, count: 0 }); // observed a high-HLC remote op → clock advances to 9000
    const opW = stampedPut({ marker: 'W', ts: 1000, clock: clockW });

    const clockL = new HlcClock({ physical: () => 5000 }); // L's fresh clock at 5000
    const opL = stampedPut({ marker: 'L', ts: 5000, clock: clockL });
    return { opW, opL };
  }

  it('the inversion is real: HLC says W wins, fed_ts says L wins', () => {
    const { opW, opL } = buildInvertedPair();
    // The merge layer's comparator (real lwwPick) picks W by HLC…
    const wEnv: OpEnvelope = { ...opW, sourceLogKeyHex: 'logW' };
    const lEnv: OpEnvelope = { ...opL, sourceLogKeyHex: 'logL' };
    expect(lwwPick(wEnv, lEnv).value).toEqual(opW.value);
    expect(lwwPick(lEnv, wEnv).value).toEqual(opW.value); // order-independent
    // …while the PG guard would keep L (the strictly-higher fed_ts).
    expect(opW.ts).toBeLessThan(opL.ts!);
    expect(opW.hlc! > opL.hlc!).toBe(true);
  });

  // EXPECTED-RED: this asserts the release-required invariant (all honest peers
  // converge to the SAME materialised row). It currently FAILS — that failure
  // IS finding D-001 (S0 non-convergence). `it.fails` keeps CI green while the
  // bug stands; when the merge fold and the PG guard are unified, the assertion
  // will pass and `it.fails` will go RED, forcing this guard to be removed.
  it.fails(
    'S0 (D-001): two peers folding the contested key in opposite orders MUST converge — they do not',
    async () => {
      const { opW, opL } = buildInvertedPair();
      const logW = singleOpLog('logW', opW);
      const logL = singleOpLog('logL', opL);

      // Peer A (e.g. L's author) folds its own log first: [logL, logW].
      const peerA = await mergeInto([logL, logW]);
      // Peer B (e.g. W's author) folds its own log first: [logW, logL].
      const peerB = await mergeInto([logW, logL]);

      // CONVERGENCE: both honest peers must materialise the SAME winner.
      expect(peerA.marker(KEY)).toBe(peerB.marker(KEY));
    },
  );

  it('characterises the divergence: peerA keeps L, peerB keeps W (both quiescent)', async () => {
    const { opW, opL } = buildInvertedPair();
    const logW = singleOpLog('logW', opW);
    const logL = singleOpLog('logL', opL);

    const peerA = await mergeInto([logL, logW]); // folds L first → guard rejects W
    const peerB = await mergeInto([logW, logL]); // folds W first → suppresses L

    // The concrete split-brain: divergent materialised rows for the same key.
    expect(peerA.marker(KEY)).toBe('L');
    expect(peerB.marker(KEY)).toBe('W');
    expect(peerA.marker(KEY)).not.toBe(peerB.marker(KEY));
  });
});

describe('D-001 control — NO inversion (HLC monotone with ts) converges', () => {
  it('when HLC order matches fed_ts order, both fold orders converge to the same row', async () => {
    // Same-clock writes with ts == HLC.physical (no recv-advance) → HLC and
    // fed_ts agree, so the system converges. This proves the divergence above is
    // SPECIFICALLY the HLC/fed_ts disagreement, not a generic merge defect.
    const clock = new HlcClock({ physical: () => 0 });
    const early: PeerLogOp = stampOpHlc(
      { type: 'put', table: TABLE, hbKey: KEY, value: { marker: 'early', ts: 1000 }, ts: 1000, schema_version: 1, author_pubkey: 'pk-e' },
      clock,
    );
    const late: PeerLogOp = stampOpHlc(
      { type: 'put', table: TABLE, hbKey: KEY, value: { marker: 'late', ts: 2000 }, ts: 2000, schema_version: 1, author_pubkey: 'pk-l' },
      clock,
    );
    const logE = singleOpLog('logE', early);
    const logL = singleOpLog('logL', late);
    const peerA = await mergeInto([logE, logL]);
    const peerB = await mergeInto([logL, logE]);
    expect(peerA.marker(KEY)).toBe('late');
    expect(peerB.marker(KEY)).toBe('late'); // converges — late has both higher HLC AND higher fed_ts
  });
});
