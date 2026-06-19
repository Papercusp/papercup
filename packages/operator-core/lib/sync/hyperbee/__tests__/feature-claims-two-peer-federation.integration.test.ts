/**
 * feature-claims-two-peer-federation.integration.test.ts — closes Brief B B-003
 * for the highest-stakes log-first table.
 *
 * `feature_claims` federates via a DIRECT `ownLog.append` (it is NOT a
 * substrate-outbox CDC table) — the orchestrator's `claimFeature`
 * (orchestrator/feature-claim.ts) appends a `claims` op whose value is a
 * `FeatureClaimRow` keyed `<feature_id>/<seq>` (seq = the writer's own-log
 * length, so each peer's claim occupies a distinct key/PK). Before this test the
 * table had only a SINGLE-PG projection-unit test (`projections/feature-claims.
 * integration.test.ts`) — the actual TWO-PEER crossing (append on A → swarm →
 * apply on B) was unproven. Yet this crossing is correctness-critical: if a
 * claim does NOT federate, two peers each believe they hold the only claim on a
 * feature and BOTH work it (a double-claim). The federation property that
 * prevents that is exactly this: a peer's claim must become VISIBLE on the other
 * peer's PG so the orchestrator can see the conflict.
 *
 * Real rig: two Swarms of one Hive on a loopback testnet DHT, mutual admission,
 * each projecting `feature_claims` into its OWN throwaway PG via the REAL
 * `buildFeatureClaimsProjection` (threaded through `_cross-peer-rig`'s
 * `extraProjections` seam). We append the op exactly as `claimFeature` does
 * (`handle.append({ table:'claims', hbKey:'<fid>/<seq>', value: FeatureClaimRow,
 * writerPubkey })`) and assert each peer's PG ends holding the OTHER peer's claim
 * with the originating own-log `claimer_pubkey` — i.e. the conflict is mutually
 * visible.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  federateTwoPeerPresence,
  pollUntil,
  rigAfterEach,
  WORKSPACE_ID,
  HARNESS_SLUG,
} from './_cross-peer-rig';
import {
  buildFeatureClaimsProjection,
  CLAIMS_TABLE_TAG,
  type FeatureClaimRow,
  _testing as claimsTesting,
} from '../projections/feature-claims';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

afterEach(rigAfterEach);

/** The REAL feature_claims DDL (000-baseline.sql) — NOT a hand-rolled subset.
 *  Includes the PK the projection's ON CONFLICT (workspace_id, harness_slug,
 *  feature_id, seq) DO NOTHING requires. */
const FEATURE_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.feature_claims (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    seq bigint NOT NULL,
    claimer_pubkey text NOT NULL,
    claimer_github_user_id bigint NOT NULL,
    claimed_at timestamp with time zone NOT NULL,
    outcome text,
    schema_version bigint DEFAULT 1 NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, feature_id, seq)
  )`;

/** Build the op exactly as orchestrator/feature-claim.ts `claimFeature` does:
 *  value = FeatureClaimRow, hbKey = the projection composeKey '<fid>/<seq>',
 *  claimer_pubkey = the writer's own-log keyHex, seq = own-log length. */
function claimOp(handle: { ownLog: { keyHex: string; length: number } }, featureId: string, githubUserId: number) {
  const seq = handle.ownLog.length;
  const row: FeatureClaimRow = {
    harness_slug: HARNESS_SLUG,
    feature_id: featureId,
    seq,
    claimer_pubkey: handle.ownLog.keyHex,
    claimer_github_user_id: githubUserId,
    claimed_at: 1_700_000_000_000 + seq,
    outcome: null,
    schema_version: CURRENT_SCHEMA_VERSION,
  };
  return {
    type: 'put' as const,
    table: CLAIMS_TABLE_TAG,
    hbKey: claimsTesting.composeKey(row),
    value: row,
    ts: row.claimed_at,
    schema_version: CURRENT_SCHEMA_VERSION,
    writerPubkey: handle.ownLog.keyHex,
  };
}

async function readClaim(sql: import('postgres').Sql, featureId: string, claimerPubkey: string) {
  const rows = await sql<Array<FeatureClaimRow & { workspace_id: string }>>`
    SELECT workspace_id, harness_slug, feature_id, seq, claimer_pubkey,
           claimer_github_user_id, schema_version
      FROM harness_shared.feature_claims
     WHERE harness_slug = ${HARNESS_SLUG} AND feature_id = ${featureId}
       AND claimer_pubkey = ${claimerPubkey}
  `;
  return rows[0];
}

describe('feature_claims — two-peer federation (B-003: the double-claim-visibility crossing)', () => {
  it(
    "each peer's claim federates to the other (conflicting claims become mutually visible)",
    async () => {
      // Two connected, mutually-admitted peers, each wiring the REAL feature_claims
      // projection into its apply (bound to its own PG).
      const { dbA, dbB, idA, idB, peerA, peerB, federated } = await federateTwoPeerPresence((sql) => [
        buildFeatureClaimsProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }),
      ]);
      expect(federated, 'the two peers never connected/federated presence (rig precondition)').toBeTruthy();

      // The claims table must exist before any claims op is applied. The presence
      // handshake above appended only presence ops, so no claims op has crossed yet.
      await dbA.sql.unsafe(FEATURE_CLAIMS_DDL);
      await dbB.sql.unsafe(FEATURE_CLAIMS_DDL);

      // ── Each peer claims a DISTINCT feature (using the producer's real
      // seq = own-log length). Distinct feature_ids → distinct keys/PKs, so the
      // crossing is deterministic regardless of equal own-log lengths. ──
      const FEATURE_A = 'F-claimed-by-A';
      const FEATURE_B = 'F-claimed-by-B';
      const pubA = peerA.handle.ownLog.keyHex;
      const pubB = peerB.handle.ownLog.keyHex;
      await peerA.handle.append(claimOp(peerA.handle, FEATURE_A, idA.userId));
      await peerB.handle.append(claimOp(peerB.handle, FEATURE_B, idB.userId));

      // ── THE PROOF: after federation each peer's PG holds the OTHER peer's claim
      // — the property that lets the orchestrator on B see A's claim (and so detect
      // a would-be double-claim) instead of both peers working it blind. ──
      const crossed = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          const aSeesBClaim = await readClaim(dbA.sql, FEATURE_B, pubB);
          const bSeesAClaim = await readClaim(dbB.sql, FEATURE_A, pubA);
          return aSeesBClaim && bSeesAClaim ? { aSeesBClaim, bSeesAClaim } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(
        crossed,
        'a feature_claims op never crossed peer→peer — a real hive would double-claim (each peer blind to the other)',
      ).toBeTruthy();

      // B's view of A's claim carries A's identity + the federated columns intact
      // (column-completeness at the crossing, not just the key).
      expect(crossed!.bSeesAClaim.claimer_pubkey).toBe(pubA);
      expect(Number(crossed!.bSeesAClaim.claimer_github_user_id)).toBe(idA.userId);
      expect(crossed!.bSeesAClaim.feature_id).toBe(FEATURE_A);
      expect(Number(crossed!.bSeesAClaim.schema_version)).toBe(CURRENT_SCHEMA_VERSION);
      // A's view of B's claim is B's, not a mislabeled echo of A's own.
      expect(crossed!.aSeesBClaim.claimer_pubkey).toBe(pubB);
      expect(Number(crossed!.aSeesBClaim.claimer_github_user_id)).toBe(idB.userId);
      expect(crossed!.aSeesBClaim.feature_id).toBe(FEATURE_B);

      // A peer does NOT re-author the remote claim under its OWN pubkey (no echo
      // corruption): B holds A's claim under A's pubkey only.
      expect(await readClaim(dbB.sql, FEATURE_A, pubB), 'B mis-attributed A’s claim to itself').toBeFalsy();
    },
    90_000,
  );
});
