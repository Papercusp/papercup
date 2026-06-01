/**
 * feature-claim — Model B Stage-5 LWW advisory claim tests.
 *
 * Plan: papercusp-substrate-model-b-rewrite-2026-05-31 (Stage 5).
 *
 * Covers:
 *   - claimFeature appends exactly one claim op to the OWN log and returns
 *     `{ claimed: true }` immediately (no merge-order wait).
 *   - The appended op's value is a `FeatureClaimRow` that the EXISTING
 *     feature-claims projection's `decodeValue` accepts, and its `hbKey` is
 *     the projection's `composeKey` of that row — so it round-trips PG.
 *   - Two claims on the same feature with different ts: the later one is the
 *     LWW winner a subsequent read-merge keeps (asserted at the op level via
 *     mergeAdmittedLogs over an applyImpl sink) and the clobber path is
 *     reachable (cross-author op carries writerPubkey).
 *   - Validation (harness_slug + feature_id + claimer_github_user_id).
 */

import { describe, expect, it } from 'vitest';
import {
  claimFeature,
  ClaimValidationError,
  type ClaimOwnLog,
} from '../feature-claim';
import { CURRENT_SCHEMA_VERSION } from '../../sync/hyperbee/schema-version';
import { _testing as projection } from '../../sync/hyperbee/projections/feature-claims';
import type { PeerLogOp } from '../../sync/hyperbee/peer-log';
import { mergeAdmittedLogs, type AdmittedLog } from '../../sync/hyperbee/read-merge';
import type { OpEnvelope } from '../../sync/hyperbee/op-envelope-types';

/**
 * In-memory own-log fake. Captures appended ops + reports `length`/`keyHex`
 * exactly like the booted handle's `ownLog`. NO merge / read-back wait —
 * `claimFeature` returns as soon as `append` resolves.
 */
class FakeOwnLog implements ClaimOwnLog {
  public ops: PeerLogOp[] = [];
  constructor(public readonly keyHex: string) {}
  get length(): number {
    return this.ops.length;
  }
  async append(op: PeerLogOp): Promise<void> {
    this.ops.push(op);
  }
}

/** Wrap a list of PeerLogOps as an AdmittedLog the read-merge can read. */
function logFrom(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return {
    keyHex,
    get length() {
      return ops.length;
    },
    async get(i: number): Promise<PeerLogOp | null> {
      return ops[i] ?? null;
    },
  };
}

describe('claimFeature — Model B advisory claim', () => {
  it('appends one claim op to the own log and returns { claimed: true }', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    const r = await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 42,
      now_ms: 1700000000000,
    });

    expect(r).toEqual({ claimed: true });
    expect(ownLog.ops).toHaveLength(1);

    const op = ownLog.ops[0];
    expect(op.type).toBe('put');
    expect(op.table).toBe('claims');
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(op.ts).toBe(1700000000000);
    expect(op.author_pubkey).toBe(ownLog.keyHex);
  });

  it('appended op value round-trips the feature-claims projection', async () => {
    const ownLog = new FakeOwnLog('bb'.repeat(32));
    await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-7',
      claimer_github_user_id: 99,
      now_ms: 1700000000123,
    });

    const op = ownLog.ops[0];
    // The projection MUST be able to decode the value...
    const row = projection.decodeValue(op.value);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      harness_slug: 'sheets',
      feature_id: 'F-7',
      seq: 0,
      claimer_pubkey: ownLog.keyHex,
      claimer_github_user_id: 99,
      claimed_at: 1700000000123,
      outcome: 'won',
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    // ...and the op's hbKey MUST equal the projection's composeKey for it.
    expect(op.hbKey).toBe(projection.composeKey(row!));
    expect(op.hbKey).toBe('F-7/0');
  });

  it('returns immediately without any merge / read-back', async () => {
    // A FakeOwnLog with no read surface (no get) is sufficient — claimFeature
    // never reads back. If it tried to await convergence this would hang/throw.
    const ownLog = new FakeOwnLog('cc'.repeat(32));
    const r = await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 1,
    });
    expect(r.claimed).toBe(true);
  });

  it('two same-feature claims with different ts: the later ts is the LWW winner', async () => {
    // Peer A claims F-1 at ts=1; peer B claims the SAME feature at ts=2.
    // Both share table+hbKey (feature_id/seq), so the read-merge resolves
    // them LWW — the later ts wins. We assert at the op level via an
    // applyImpl sink that captures whatever the merge decided to apply.
    const peerA = new FakeOwnLog('a0'.repeat(32));
    const peerB = new FakeOwnLog('b0'.repeat(32));

    await claimFeature(peerA, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 1,
      now_ms: 1,
    });
    await claimFeature(peerB, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 2,
      now_ms: 2,
    });

    // Both peers' single op land at seq 0 → identical hbKey 'F-1/0' →
    // they collide in the same LWW group, so LWW by ts decides the winner.
    expect(peerA.ops[0].hbKey).toBe('F-1/0');
    expect(peerB.ops[0].hbKey).toBe('F-1/0');

    const applied: OpEnvelope[] = [];
    await mergeAdmittedLogs(
      [logFrom(peerA.keyHex, peerA.ops), logFrom(peerB.keyHex, peerB.ops)],
      {
        getTimeoutMs: 0,
        applyImpl: async (op) => {
          applied.push(op);
          return true;
        },
      },
    );

    // Exactly one winner applied for the colliding key; it is peer B's
    // (ts=2 > ts=1), and it carries the cross-author writerPubkey so the
    // clobber-event path is reachable.
    expect(applied).toHaveLength(1);
    expect(applied[0].ts).toBe(2);
    expect(applied[0].writerPubkey).toBe(peerB.keyHex);
    const winnerRow = projection.decodeValue(applied[0].value);
    expect(winnerRow?.claimer_github_user_id).toBe(2);
  });

  it('rejects empty harness_slug', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    await expect(
      claimFeature(ownLog, { harness_slug: '', feature_id: 'F-1', claimer_github_user_id: 1 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it('rejects empty feature_id', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    await expect(
      claimFeature(ownLog, { harness_slug: 'sheets', feature_id: '', claimer_github_user_id: 1 }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it('rejects non-positive / non-integer claimer_github_user_id', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    for (const bad of [0, -5, 1.5]) {
      await expect(
        claimFeature(ownLog, {
          harness_slug: 'sheets',
          feature_id: 'F-1',
          claimer_github_user_id: bad,
        }),
      ).rejects.toBeInstanceOf(ClaimValidationError);
    }
  });

  it('uses now_ms override for deterministic ts + claimed_at', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-1',
      claimer_github_user_id: 1,
      now_ms: 1234567,
    });
    expect(ownLog.ops[0].ts).toBe(1234567);
    expect(projection.decodeValue(ownLog.ops[0].value)?.claimed_at).toBe(1234567);
  });

  it('uses ownLog.length as the append-only seq', async () => {
    const ownLog = new FakeOwnLog('aa'.repeat(32));
    // Pre-seed two prior ops so the next claim lands at seq 2.
    ownLog.ops.push({} as PeerLogOp, {} as PeerLogOp);
    await claimFeature(ownLog, {
      harness_slug: 'sheets',
      feature_id: 'F-9',
      claimer_github_user_id: 1,
      now_ms: 100,
    });
    const op = ownLog.ops[2];
    expect(projection.decodeValue(op.value)?.seq).toBe(2);
    expect(op.hbKey).toBe('F-9/2');
  });
});
