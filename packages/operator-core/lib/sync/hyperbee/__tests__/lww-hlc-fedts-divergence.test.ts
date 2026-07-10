/**
 * lww-hlc-fedts-divergence.test.ts — Brief D/J (shared-pot-release-testing),
 * finding D-001. Now PROVES the SHIPPED FIX (migration 314 + the projection
 * `fed_hlc` guard): two honest peers folding a contested key in opposite orders
 * CONVERGE, because the PG guard now orders by the same HLC key the merge fold
 * does. A companion test keeps the LEGACY `fed_ts`-guard divergence as a
 * characterisation of the pre-314 S0 the fix removed.
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
 * A faithful in-memory transcription of EVERY mutable projection's PG LWW guard.
 *
 * `mode: 'fed_hlc'` (DEFAULT, the SHIPPED D-001 fix — migration 314 + the
 * projection `ON CONFLICT … WHERE EXCLUDED.fed_hlc >= stored.fed_hlc` with a
 * `fed_ts` fallback): orders by the op's HLC when both sides carry one. This is
 * what unifies the merge fold's order and the PG guard's order, so the guard
 * never rejects a fold-winner under skew → convergence.
 *
 * `mode: 'fed_ts'` (LEGACY, the pre-314 bug surface): orders by `fed_ts = op.ts`
 * wall clock only — kept to characterise the divergence the fix removed.
 *
 * Returns whether the row was (re)written — same boolean the real `applyOpVia`
 * returns.
 */
class FedTsGuardedStore {
  readonly rows = new Map<string, { fedTs: number | null; hlc?: string; value: unknown }>();
  constructor(private readonly mode: 'fed_ts' | 'fed_hlc' = 'fed_hlc') {}
  apply = async (op: OpEnvelope): Promise<boolean> => {
    if (op.type !== 'put' || !op.hbKey) return false;
    const incoming = op.ts ?? null; // fed_ts = provenance.ts = op.ts
    const incHlc = op.hlc ?? null;
    const cur = this.rows.get(op.hbKey);
    if (this.mode === 'fed_hlc') {
      // SHIPPED guard: HLC compare when both present, else fed_ts fallback.
      if (cur) {
        const curHlc = cur.hlc ?? null;
        const beats =
          incHlc !== null && curHlc !== null
            ? incHlc >= curHlc
            : cur.fedTs === null || (incoming !== null && incoming >= cur.fedTs);
        if (!beats) return false;
      }
      this.rows.set(op.hbKey, { fedTs: incoming, hlc: incHlc ?? undefined, value: op.value });
      return true;
    }
    // LEGACY fed_ts guard: applies iff no stored row, stored fed_ts NULL, or incoming >= stored.
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
 *  guarded store (default the SHIPPED `fed_hlc` guard; pass 'fed_ts' for the
 *  legacy bug surface), and return the store's converged value for KEY. */
async function mergeInto(
  logs: AdmittedLog[],
  mode: 'fed_ts' | 'fed_hlc' = 'fed_hlc',
): Promise<FedTsGuardedStore> {
  const store = new FedTsGuardedStore(mode);
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

  // RELEASE INVARIANT, now GREEN (the shipped `fed_hlc` guard): both honest peers
  // converge to the SAME materialised row regardless of fold order. Flipped from
  // `it.fails` once migration 314 + the projection guard unified the merge fold's
  // order and the PG guard's order onto the HLC key. W (higher HLC) wins on both.
  it('S0 (D-001) FIXED: two peers folding the contested key in opposite orders converge', async () => {
    const { opW, opL } = buildInvertedPair();
    const logW = singleOpLog('logW', opW);
    const logL = singleOpLog('logL', opL);

    const peerA = await mergeInto([logL, logW]); // folds L first
    const peerB = await mergeInto([logW, logL]); // folds W first

    expect(peerA.marker(KEY)).toBe(peerB.marker(KEY)); // converge
    expect(peerA.marker(KEY)).toBe('W'); // …on the HLC winner
  });

  it('LEGACY fed_ts guard characterises the OLD divergence: peerA keeps L, peerB keeps W', async () => {
    const { opW, opL } = buildInvertedPair();
    const logW = singleOpLog('logW', opW);
    const logL = singleOpLog('logL', opL);

    // The pre-314 bug surface: the fed_ts-ordered guard diverges (this is the S0
    // the fix removed; kept as a teeth/characterisation of the legacy behaviour).
    const peerA = await mergeInto([logL, logW], 'fed_ts'); // folds L first → guard rejects W
    const peerB = await mergeInto([logW, logL], 'fed_ts'); // folds W first → suppresses L

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
