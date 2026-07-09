/**
 * hive-policy projection — real-PG integration teeth (shared-hive-owner-enforcement
 * EN-1). The S0 properties of the foundation:
 *   • an owner-signed policy APPLIES on a member (round-trip owner→member) and reads
 *     back via getHivePolicy;
 *   • a NEWER policy_version wins, a stale replay does NOT (fed_hlc LWW order);
 *   • a FORGED / wrong-signer / unsigned policy is DROPPED at apply — and the TEETH:
 *     neuter the verify (verifyPolicy → always true) and the SAME forged policy applies
 *     (proving the signature check is load-bearing, not vacuous);
 *   • absent policy ⇒ getHivePolicy null (no behavior change).
 *
 * Drives the projection's writeToPg directly with real PG (the apply side a member runs
 * on a received op), mirroring projections/hive-members.integration.test.ts. The hive
 * identity row (the verify trust anchor) is seeded with a keypair we hold, so we can
 * sign as the owner (signWithPrivateKeyDer == what signWithHiveKey does internally).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../../identity/ed25519';
import { hiveKeychainId } from '../../../identity/hive-keypair';
import { insertHiveIfAbsent } from '../../../hive-store';
import { getHivePolicy } from '../../../hive-policy-store';
import { canonicalizeHivePolicy, hivePolicySignedBytes, type HivePolicy } from '../../../hive-policy-schema';
import { buildHivePolicyProjection, type HivePolicyRow, type HivePolicyProjectionOpts } from './hive-policy';
import type { ProvenanceContext } from '../projection';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../libs/papercusp/libs/db/sql');
const WS = 'ws-policy';
const HOME = 'alpha';

// The hive_policy table DDL (the columns the projection writes). We create it directly
// (no triggers — writeToPg is a plain upsert) to avoid the capture/stamp function chain,
// exactly as the hive-members projection test does for its table.
const HIVE_POLICY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.hive_policy (
    workspace_id text NOT NULL, harness_slug text NOT NULL,
    policy_json text NOT NULL, owner_pubkey text NOT NULL, signature text NOT NULL,
    policy_version integer NOT NULL DEFAULT 1, author_pubkey text,
    origin text NOT NULL DEFAULT 'local', fed_ts bigint, fed_hlc text,
    created_at bigint NOT NULL, updated_at bigint NOT NULL DEFAULT 0,
    CONSTRAINT hive_policy_pkey PRIMARY KEY (workspace_id, harness_slug)
  );
`;

let db: FreshPgDb;
// The owner hive keypair (we hold the private key to sign as the owner).
const ownerKp = generateEd25519KeypairDer();

beforeAll(async () => {
  db = await createFreshPgDb('hive-policy-proj');
  await db.sql.unsafe(readFileSync(join(SQL_DIR, '184-hives-table.sql'), 'utf8'));
  await db.sql.unsafe(HIVE_POLICY_DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.hive_policy, harness_shared.hives CASCADE');
});

async function seedHive(pubkeyBase64 = ownerKp.pubkeyBase64) {
  await insertHiveIfAbsent(
    { workspaceId: WS, homeSlug: HOME, pubkeyBase64, keychainId: hiveKeychainId(WS, HOME) },
    db.sql,
  );
}

/** Build a SIGNED wire row as the owner would author it (owner_pubkey = the hive key). */
function signedRow(policy: HivePolicy, policyVersion: number, kp = ownerKp): HivePolicyRow {
  const policy_json = canonicalizeHivePolicy(policy);
  const bytes = hivePolicySignedBytes({ workspaceId: WS, potHomeSlug: HOME, policyVersion, canonicalPolicyJson: policy_json });
  const signature = signWithPrivateKeyDer(kp.privateKeyDer, bytes).toString('base64');
  return { harness_slug: HOME, policy_json, owner_pubkey: kp.pubkeyBase64, signature, policy_version: policyVersion };
}

function prov(fedHlc: string, ts = 1700): ProvenanceContext {
  return { authorPubkey: 'device', origin: 'remote', ts, fedHlc };
}
function opts(over: Partial<HivePolicyProjectionOpts> = {}): HivePolicyProjectionOpts {
  return { workspaceId: WS, harnessSlug: HOME, sql: db.sql, ...over };
}

describe('hive-policy projection — apply-side teeth (real PG)', () => {
  it('round-trip: an owner-signed policy APPLIES on a member + reads back', async () => {
    await seedHive();
    const proj = buildHivePolicyProjection(opts());
    const policy: HivePolicy = { membership: 'allowlist', allowlist: ['octocat'], rate: { opsPerMin: 5 } };
    await proj.writeToPg!(signedRow(policy, 1), prov('000000000001700:00000'));

    const got = await getHivePolicy(WS, HOME, db.sql);
    expect(got).not.toBeNull();
    expect(got!.policyVersion).toBe(1);
    expect(got!.policy).toEqual(policy);
    expect(got!.ownerPubkey).toBe(ownerKp.pubkeyBase64);
  });

  it('absent policy ⇒ getHivePolicy null (no behavior change for existing Hives)', async () => {
    await seedHive();
    expect(await getHivePolicy(WS, HOME, db.sql)).toBeNull();
  });

  it('LWW: a newer fed_hlc wins; a stale replay does NOT overwrite', async () => {
    await seedHive();
    const proj = buildHivePolicyProjection(opts());
    await proj.writeToPg!(signedRow({ membership: 'open' }, 1), prov('000000000001000:00000'));
    await proj.writeToPg!(signedRow({ membership: 'approval' }, 2), prov('000000000002000:00000'));
    expect((await getHivePolicy(WS, HOME, db.sql))!.policy.membership).toBe('approval'); // v2 wins

    // Stale replay of v1 (lower fed_hlc) must NOT clobber v2.
    await proj.writeToPg!(signedRow({ membership: 'open' }, 1), prov('000000000001000:00000'));
    const after = await getHivePolicy(WS, HOME, db.sql);
    expect(after!.policy.membership).toBe('approval');
    expect(after!.policyVersion).toBe(2);
  });

  it('S0: a FORGED policy (attacker key) is DROPPED at apply (verify trust anchor)', async () => {
    await seedHive(); // the hive identity is ownerKp
    const proj = buildHivePolicyProjection(opts());
    // Attacker signs with their OWN key + advertises their own owner_pubkey.
    const attacker = generateEd25519KeypairDer();
    await proj.writeToPg!(signedRow({ membership: 'open' }, 1, attacker), prov('000000000003000:00000'));
    expect(await getHivePolicy(WS, HOME, db.sql)).toBeNull(); // dropped — owner_pubkey != hive identity
  });

  it('S0: an UNSIGNED / garbage-signature policy is DROPPED at apply', async () => {
    await seedHive();
    const proj = buildHivePolicyProjection(opts());
    const row = signedRow({ membership: 'open' }, 1);
    await proj.writeToPg!({ ...row, signature: 'bm90LWEtc2ln' }, prov('000000000003000:00000')); // bad sig
    expect(await getHivePolicy(WS, HOME, db.sql)).toBeNull();
  });

  it('TEETH: neuter the verify ⇒ the SAME forged policy APPLIES (the sig check is load-bearing)', async () => {
    await seedHive();
    // verifyPolicy stubbed to always-true = the "neutered sig check" the brief calls for.
    const proj = buildHivePolicyProjection(opts({ verifyPolicy: async () => true }));
    const attacker = generateEd25519KeypairDer();
    await proj.writeToPg!(signedRow({ membership: 'open' }, 1, attacker), prov('000000000003000:00000'));
    // With the verify neutered, the forged policy lands → proves the real verify is what
    // drops it in the test above (not some unrelated guard). RED if the verify is removed.
    expect(await getHivePolicy(WS, HOME, db.sql)).not.toBeNull();
  });

  it('drops a policy when the hive identity row is absent (fail closed)', async () => {
    // No seedHive() — the trust anchor (hives row) doesn't exist locally yet.
    const proj = buildHivePolicyProjection(opts());
    await proj.writeToPg!(signedRow({ membership: 'open' }, 1), prov('000000000004000:00000'));
    expect(await getHivePolicy(WS, HOME, db.sql)).toBeNull();
  });
});
