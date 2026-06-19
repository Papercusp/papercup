/**
 * contributors-two-peer-federation.integration.test.ts — Brief B B-003 for the
 * `contributors` log-first table (the per-harness contributor/device roster).
 *
 * `contributors` federates via a DIRECT `ownLog.append` (NOT substrate-outbox):
 * `publishContributorRow` (write-contributor-row.ts) appends a `contributors` op
 * keyed `<github_user_id>` whose value is a `ContributorRow` (github identity +
 * the `device_attestations` JSONB array + `revoked_pubkeys` + `binding_status`).
 * Before this test it had only a SINGLE-PG projection-unit test — the real
 * TWO-PEER crossing (publish on A → swarm → apply on B) was unproven. This roster
 * is admission-relevant: it is how a peer learns who is an admitted contributor
 * and which devices are attested, so its crossing — AND its tombstone (a removed
 * contributor's `del` must propagate, the EI-79 ts-guarded delete) — must hold.
 *
 * Real rig: two mutually-admitted Swarms of one Hive on a loopback testnet DHT,
 * each wiring the REAL `contributors` projection into its apply (via the
 * `_cross-peer-rig` `extraProjections` seam). We append exactly as
 * `publishContributorRow` does and assert (1) the row crosses A→B with the JSONB
 * attestations + binding_status intact, and (2) a later tombstone crosses A→B and
 * removes the row on B.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  federateTwoPeerPresence,
  pollUntil,
  rigAfterEach,
  WORKSPACE_ID,
  HARNESS_SLUG,
} from './_cross-peer-rig';
import { buildContributorsProjection } from '../projections/contributors';
import type { ContributorRow, DeviceAttestationEntry } from '../../../harness/contributor-row-types';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

afterEach(rigAfterEach);

/** The REAL contributors DDL (000-baseline.sql) — NOT a hand-rolled subset.
 *  Includes the PK the projection's ON CONFLICT (workspace_id, harness_slug,
 *  github_user_id) + the EI-79 `fed_ts` LWW column the apply requires. */
const CONTRIBUTORS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.contributors (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    github_user_id bigint NOT NULL,
    github_username text NOT NULL,
    display_name text,
    avatar_url text,
    device_attestations jsonb DEFAULT '[]'::jsonb NOT NULL,
    revoked_pubkeys text[] DEFAULT '{}'::text[] NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    schema_version bigint DEFAULT 1 NOT NULL,
    binding_status text DEFAULT 'unverified'::text NOT NULL,
    channel1_verified_at timestamp with time zone,
    channel2_verified_at timestamp with time zone,
    channel2_branch_ref text,
    binding_last_checked_at timestamp with time zone,
    fed_ts bigint,
    fed_hlc text,
    PRIMARY KEY (workspace_id, harness_slug, github_user_id)
  )`;

const attestation = (devicePubkey: string): DeviceAttestationEntry =>
  ({
    device_pubkey: devicePubkey,
    gist_id: 'gist-abc',
    gist_url: 'https://gist.github.com/x/abc',
    device_label: 'laptop',
    created_at: 1_700_000_000_000,
    signature_by_device: 'sig-deadbeef',
  }) as DeviceAttestationEntry;

const contributorRow = (githubUserId: number, devicePubkey: string): ContributorRow =>
  ({
    harness_slug: HARNESS_SLUG,
    github_user_id: githubUserId,
    github_username: `user-${githubUserId}`,
    display_name: `User ${githubUserId}`,
    avatar_url: null,
    device_attestations: [attestation(devicePubkey)],
    revoked_pubkeys: ['revoked-pk-1'],
    joined_at: 1_700_000_000_000,
    last_seen_at: null,
    binding_status: 'verified',
    channel1_verified_at: null,
    channel2_verified_at: null,
    channel2_branch_ref: null,
    binding_last_checked_at: null,
    schema_version: CURRENT_SCHEMA_VERSION,
  }) as ContributorRow;

async function readContributor(sql: import('postgres').Sql, githubUserId: number) {
  const rows = await sql<
    Array<{
      github_user_id: number;
      github_username: string;
      binding_status: string;
      device_attestations: DeviceAttestationEntry[];
      revoked_pubkeys: string[];
      schema_version: number;
    }>
  >`
    SELECT github_user_id, github_username, binding_status,
           device_attestations, revoked_pubkeys, schema_version
      FROM harness_shared.contributors
     WHERE harness_slug = ${HARNESS_SLUG} AND github_user_id = ${githubUserId}
  `;
  return rows[0];
}

describe('contributors — two-peer federation (B-003: roster + tombstone crossing)', () => {
  it(
    'a contributor row federates A→B with attestations intact, then its tombstone removes it on B',
    async () => {
      const { dbA, dbB, peerA, peerB, federated } = await federateTwoPeerPresence((sql) => [
        buildContributorsProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }),
      ]);
      expect(federated, 'the two peers never connected/federated presence (rig precondition)').toBeTruthy();

      await dbA.sql.unsafe(CONTRIBUTORS_DDL);
      await dbB.sql.unsafe(CONTRIBUTORS_DDL);

      const GH = 555;
      const DEVICE = 'device-pubkey-555';

      // ── A publishes a contributor exactly as publishContributorRow does:
      // put `contributors/<github_user_id>` with the ContributorRow value. ──
      await peerA.handle.append({
        type: 'put',
        table: 'contributors',
        hbKey: String(GH),
        value: contributorRow(GH, DEVICE),
        ts: 1000,
        schema_version: CURRENT_SCHEMA_VERSION,
        writerPubkey: peerA.handle.ownLog.keyHex,
      });

      // ── PROOF 1 (insert crossing): the row lands on B with the JSONB
      // attestations + binding_status + revoked_pubkeys intact (column-complete). ──
      const onB = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          return await readContributor(dbB.sql, GH);
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(onB, 'the contributor row never crossed A→B').toBeTruthy();
      expect(onB!.github_username).toBe(`user-${GH}`);
      expect(onB!.binding_status).toBe('verified');
      expect(Number(onB!.schema_version)).toBe(CURRENT_SCHEMA_VERSION);
      // JSONB attestation array survives byte-equal (the requeue_count-class concern
      // at the jsonb grain — not silently flattened to a string/empty array).
      expect(Array.isArray(onB!.device_attestations)).toBe(true);
      expect(onB!.device_attestations).toHaveLength(1);
      expect(onB!.device_attestations[0].device_pubkey).toBe(DEVICE);
      expect(onB!.device_attestations[0].gist_id).toBe('gist-abc');
      expect(onB!.revoked_pubkeys).toEqual(['revoked-pk-1']);

      // ── A removes the contributor (a `del` tombstone with a strictly-newer ts so
      // it wins the EI-79 ts-guard). publishContributorRow's removal path is the
      // same op shape with type:'del'. ──
      await peerA.handle.append({
        type: 'del',
        table: 'contributors',
        hbKey: String(GH),
        ts: 2000,
        schema_version: CURRENT_SCHEMA_VERSION,
        writerPubkey: peerA.handle.ownLog.keyHex,
      });

      // ── PROOF 2 (tombstone crossing): the row is removed on B. ──
      const removedOnB = await pollUntil(
        async () => {
          await peerA.handle.mergeNow();
          await peerB.handle.mergeNow();
          const row = await readContributor(dbB.sql, GH);
          return row == null ? { gone: true } : undefined;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(
        removedOnB,
        'the contributor tombstone never crossed A→B — a removed contributor would linger on the peer',
      ).toBeTruthy();
    },
    90_000,
  );
});
