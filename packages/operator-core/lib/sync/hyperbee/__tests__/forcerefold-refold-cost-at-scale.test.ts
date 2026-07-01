/**
 * forcerefold-refold-cost-at-scale.test.ts
 *
 * Brief 9 (federation-release-hardening) — the LOCAL/deterministic half: characterize
 * the COST of the A-003 `forceReFold` re-fold at scale, and prove log-snapshot
 * compaction BOUNDS it. Answers Brief 9's "does forceReFold (re-folds ALL admitted
 * logs per home-resolving rekey) cause a perf cliff at scale? Confirm the
 * snapshot-seeding interaction."
 *
 * ## What forceReFold costs
 * On a home-resolving rekey rebind, boot.ts mergeOnePass RESETS the merge cursor
 * (`mergeCursor = createMergeCursor()`) so EVERY admitted log re-folds through the
 * newly-bound projections (the A-003 fix, exercised end-to-end by
 * owner-roster-rebind-race.repro.integration.test.ts). A reset re-fold decodes each
 * admitted log from its cursor start — so its cost is O(total ops decoded). The
 * canonical cost proxy in this codebase is the incremental merge's `decoded` count
 * (read-merge.ts: "decoded: ops decoded this pass — the EI-79 cost driver — O(delta),
 * not O(history)"); it is deterministic (unlike wall-clock), so it is what we assert.
 *
 * ## The two findings this test pins (both are Brief 9 acceptance)
 *  1. NO CLIFF: the re-fold cost is exactly LINEAR in total ops — decoded == Σ log
 *     lengths, and doubling the log count OR the per-log size exactly doubles the
 *     decode count. There is no super-linear (O(N²)) blow-up hiding in the fold: the
 *     re-fold is the same O(history) a cold boot backfill already pays.
 *  2. SNAPSHOTS BOUND IT: with `papercusp-substrate-log-snapshot` ON, mergeOnePass
 *     seeds the just-reset cursor at each log's latest snapshot (seedCursorFromSnapshots),
 *     so the re-fold decodes only the snapshot op (1 decode reconstitutes the whole
 *     summarized prefix) + the post-snapshot tail — O(N·(1+tail)) instead of O(N·M).
 *     At N=20, M=500, tail=10 that is a ~45× reduction. So snapshot compaction is what
 *     keeps a per-rekey full re-fold cheap even at large log sizes.
 *
 * ## Correctness under the snapshot-bounded re-fold, at scale
 * The 3rd test extends the 1-log Brief 11 proof (owner-roster-rebind-refold-snapshot.test.ts)
 * to N logs: with snapshots ON, a forceReFold reset re-applies a dropped hive_members
 * roster op on EVERY one of N logs — via each log's snapshot summary (the cursor is
 * seeded PAST the individual op). Convergence-correctness of the reset re-fold under
 * real join/leave churn is already covered by n-peer-scale-churn.test.ts (which asserts
 * set-equality vs a brute-force LWW oracle across repeated cursor resets); this file
 * deliberately does NOT re-assert that — it owns only the COST + snapshot-bounding axis.
 *
 * ## Layer + the live complement
 * Direct-drive over the real createMergeCursor / seedCursorFromSnapshots /
 * mergeAdmittedLogsIncremental / buildSnapshotOp — the exact functions + order boot.ts
 * mergeOnePass uses — so the decode counts are the production re-fold's. This is the
 * ALGORITHMIC cost (decode-count scaling); the real-wall-clock / RSS sustained soak at
 * many-real-members is the complementary LIVE piece for the Hetzner rig (Brief 9 live).
 *
 * RUN (unit layer — pure functions + in-memory fakes, no PG/Docker):
 *   cd packages/operator-core && npx vitest run \
 *     lib/sync/hyperbee/__tests__/forcerefold-refold-cost-at-scale.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  mergeAdmittedLogsIncremental,
  seedCursorFromSnapshots,
  createMergeCursor,
  type AdmittedLog,
} from '../read-merge';
import { buildSnapshotOp } from '../log-snapshot';
import type { PeerLogOp } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';

function fakeLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
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

function put(table: string, hbKey: string, ts: number, value?: unknown): PeerLogOp {
  return {
    type: 'put',
    table,
    hbKey,
    value: value ?? { id: hbKey, ts },
    ts,
    schema_version: 1,
    author_pubkey: `pk-${keyHexOf(table)}`,
  } as PeerLogOp;
}
// tiny stable author-pubkey helper (no Math.random / Date)
function keyHexOf(s: string): string {
  return s.slice(0, 4);
}

/** N logs, each M distinct puts, NO snapshot — the uncompacted baseline. */
function buildPlainLogs(N: number, M: number): AdmittedLog[] {
  const logs: AdmittedLog[] = [];
  for (let n = 0; n < N; n++) {
    const ops: PeerLogOp[] = [];
    for (let i = 0; i < M; i++) ops.push(put('features_consolidated', `L${n}-K${i}`, 1000 + n * 100000 + i));
    logs.push(fakeLog(`log-${n}`, ops));
  }
  return logs;
}

/** N logs, each = [M puts, snapshot covering [0,M), `tail` more puts]. The snapshot
 *  sits at index M; the M individual puts are the summarized prefix. */
function buildCompactedLogs(N: number, M: number, tail: number): { logs: AdmittedLog[]; snapIndex: number } {
  const logs: AdmittedLog[] = [];
  for (let n = 0; n < N; n++) {
    const prefix: PeerLogOp[] = [];
    for (let i = 0; i < M; i++) prefix.push(put('features_consolidated', `L${n}-K${i}`, 1000 + n * 100000 + i));
    const snap = buildSnapshotOp({ ops: prefix, coversUpTo: prefix.length, author_pubkey: `pk-${keyHexOf(`log-${n}`)}`, ts: 1000 + n * 100000 + M, schema_version: 1 });
    const tailOps: PeerLogOp[] = [];
    for (let j = 0; j < tail; j++) tailOps.push(put('features_consolidated', `L${n}-T${j}`, 1000 + n * 100000 + M + 1 + j));
    logs.push(fakeLog(`log-${n}`, [...prefix, snap, ...tailOps]));
  }
  return { logs, snapIndex: M };
}

/** A forceReFold re-fold: a FRESH cursor (== boot.ts `createMergeCursor()` on the
 *  rekey rebind), optional snapshot seeding (== the snapshotEnabled branch), then ONE
 *  unbounded incremental pass. Returns the decode count (the cost) + apply count. */
async function refold(
  logs: AdmittedLog[],
  opts: { seed: boolean; applyImpl?: (op: OpEnvelope) => Promise<boolean> },
): Promise<{ decoded: number; applied: number }> {
  const cursor = createMergeCursor();
  if (opts.seed) await seedCursorFromSnapshots(logs, cursor, { getTimeoutMs: 0 });
  const apply = opts.applyImpl ?? (async () => true);
  const res = await mergeAdmittedLogsIncremental(logs, cursor, {
    applyImpl: apply,
    getTimeoutMs: 0,
    maxOpsPerPass: 0, // unbounded — one pass reads the whole re-fold (the boot re-fold shape)
  });
  return { decoded: res.decoded, applied: res.applied };
}

describe('Brief 9 — forceReFold re-fold COST at scale: linear (no cliff), and snapshot-compaction-bounded', () => {
  it('the re-fold cost is exactly LINEAR in total ops — no super-linear cliff (decoded == Σ log lengths; ×logs and ×size each ×2 the cost)', async () => {
    const base = await refold(buildPlainLogs(10, 200), { seed: false });
    const moreLogs = await refold(buildPlainLogs(20, 200), { seed: false });
    const biggerLogs = await refold(buildPlainLogs(10, 400), { seed: false });

    // A reset re-fold decodes EVERY op of EVERY admitted log exactly once — the cost
    // is precisely O(total ops), the same O(history) a cold boot backfill pays.
    expect(base.decoded).toBe(10 * 200);
    expect(moreLogs.decoded).toBe(20 * 200);
    expect(biggerLogs.decoded).toBe(10 * 400);

    // Doubling the number of admitted logs, OR the per-log op count, exactly doubles
    // the decode count — LINEAR. A super-linear (e.g. O(N²)) fold would blow past 2×.
    expect(moreLogs.decoded / base.decoded).toBe(2);
    expect(biggerLogs.decoded / base.decoded).toBe(2);
  });

  it('log-snapshot compaction BOUNDS the re-fold to O(N·(1+tail)) instead of O(N·M) — a ~45× cut at N=20,M=500,tail=10', async () => {
    const N = 20;
    const M = 500;
    const TAIL = 10;
    const { logs, snapIndex } = buildCompactedLogs(N, M, TAIL);

    // Flag OFF path (no seeding): the reset re-fold reads the whole log — the M
    // summarized puts + the snapshot op + the tail = N·(M+1+tail).
    const noSeed = await refold(logs, { seed: false });
    expect(noSeed.decoded).toBe(N * (M + 1 + TAIL));

    // Flag ON path: seedCursorFromSnapshots positions each fresh cursor AT the snapshot
    // (index M), so the re-fold decodes only the snapshot op (1) + the tail per log.
    const seeded = await refold(logs, { seed: true });
    expect(snapIndex).toBe(M);
    expect(seeded.decoded).toBe(N * (1 + TAIL)); // 20·11 = 220

    // The bound is real + large: seeding cuts the per-rekey re-fold cost by >10× here
    // (actually ~46×), and vs an UNCOMPACTED log of the same live size it is N·(1+tail)
    // (220) instead of N·M (10 000) — a ~45× reduction. This is what keeps a full
    // re-fold on EVERY home-resolving rekey cheap at large log sizes.
    expect(seeded.decoded).toBeLessThan(noSeed.decoded / 10);
    const uncompactedEquivalent = N * M; // 10 000 — a plain log of the same live row count
    expect(seeded.decoded).toBeLessThan(uncompactedEquivalent / 40);
  });

  it('correctness holds under the snapshot-bounded re-fold at scale: a dropped hive_members roster op re-applies on ALL N logs via each snapshot summary (extends the 1-log Brief 11 proof)', async () => {
    const N = 25;
    const HIVE_HOME = 'scale-owner-hive';
    const MEMBER_SLUG = 'scale-joined-hive';

    // Each of N owner logs: a roster row targeting HIVE_HOME (index 0), then a snapshot
    // covering [0,1) (index 1) that summarizes it. The individual roster op is BELOW the
    // snapshot, so a snapshot-seeded re-fold skips it — recovery can only come from the
    // snapshot summary.
    const logs: AdmittedLog[] = [];
    for (let n = 0; n < N; n++) {
      const roster = put('hive_members', `owner-${n}`, 1000 + n, { hive_home_slug: HIVE_HOME, github_user_id: n });
      const snap = buildSnapshotOp({ ops: [roster], coversUpTo: 1, author_pubkey: `pk-${keyHexOf(`log-${n}`)}`, ts: 1000 + n + 1, schema_version: 1 });
      logs.push(fakeLog(`log-${n}`, [roster, snap])); // snapshot at index 1 (> 0, so seeding engages)
    }

    // A projection-binding-aware sink (as in the Brief 11 unit test): a hive_members op
    // whose hive_home_slug != the bound slug is DROPPED (the home=<none> member-slug drop).
    function bindingSink(boundSlug: string) {
      let landed = 0;
      const applyImpl = async (op: OpEnvelope): Promise<boolean> => {
        const target = (op.value as { hive_home_slug?: string } | undefined)?.hive_home_slug;
        if (op.table === 'hive_members' && target === boundSlug) {
          landed++;
          return true;
        }
        return false;
      };
      return { landed: () => landed, applyImpl };
    }

    // Phase 1 — home=<none> (member-slug bound), snapshots ON: every roster op is dropped.
    const member = bindingSink(MEMBER_SLUG);
    await refold(logs, { seed: true, applyImpl: member.applyImpl });
    expect(member.landed(), 'pre-rekey at scale: all N roster ops dropped under the member-slug binding').toBe(0);

    // Phase 2 — the forceReFold reset (fresh cursor) + snapshot seeding + hive-home binding:
    // every one of the N roster ops re-applies, each via its own snapshot summary.
    const home = bindingSink(HIVE_HOME);
    await refold(logs, { seed: true, applyImpl: home.applyImpl });
    expect(home.landed(), 'post-rekey at scale: the forceReFold reset + snapshot seeding re-applies the dropped roster op on ALL N logs').toBe(N);
  });
});
