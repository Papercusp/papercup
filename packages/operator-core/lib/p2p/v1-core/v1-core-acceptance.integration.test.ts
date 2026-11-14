/**
 * P2P v1 core acceptance — p2p-v1-core-release-2026-11-13, integration layer (real Postgres).
 *
 * R-8 (P-001): a hive refuses a join beyond the v1 size limit. N is read from the v1 scope
 * contract, never from the admission code. The membership fixtures are built here and the
 * roster is observed through the real store (pot_members), so the count asserted is the
 * count the database holds, not what the code under test reports.
 *
 * The limit belongs to the v1 release build: each case runs with the documented launch
 * variable set, and one control case shows a dev build still admits the N+1th joiner.
 *
 * Later plan items extend this file with the multi-peer cases for R-1..R-6 and R-9.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { approvePendingJoin, ownerAdmitOrPend, type MembershipAdmissionDeps } from '../../hive-membership-admission';
import { getPendingJoin, listPendingJoins } from '../../hive-pending-joins-store';
import { listHiveMembers } from '../../hive-membership-store';
import { unsafeFederatedPotScope } from '../../federated-pot-scope';
import { upsertHivePolicyRow } from '../../hive-policy-store';
import { canonicalizeHivePolicy, type HivePolicy } from '../../hive-policy-schema';
import { insertHiveIfAbsent } from '../../hive-store';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import { hiveKeychainId } from '../../identity/hive-keypair';
import type { DeviceAttestationEntry } from '../../harness/contributor-row-types';
import { V1_HIVE_SIZE_LIMIT } from './v1-scope-contract';

/** The documented launch switch of the v1 release build (see the contract's header). */
const RELEASE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_P2P_V1_RELEASE_BUILD';

const N = V1_HIVE_SIZE_LIMIT;
const WS = 'ws-v1-core';
const HIVE = unsafeFederatedPotScope('v1-hive', 'integration fixture: one synthetic pot slug, written and read');

let db: OrgTestDb;
let sql: Sql;

function device(pubkey: string): DeviceAttestationEntry {
  return { device_pubkey: pubkey, gist_id: 'g', gist_url: 'u', device_label: 'd', created_at: 1, signature_by_device: 's' };
}

/** Joiner #i, built independently of the admission code: a GitHub identity plus one device. */
function joiner(i: number, devicePubkey = `dev-${i}`) {
  return {
    githubUserId: 5000 + i,
    githubUsername: `member-${i}`,
    displayName: `Member ${i}`,
    avatarUrl: null,
    deviceAttestations: [device(devicePubkey)],
  };
}

/** The epoch-key reconnect heal is not under test here; keep it from touching other tables. */
const deps = (): MembershipAdmissionDeps => ({ sql, refederateMemberEpochKeys: async () => {} });

const admit = (i: number, devicePubkey?: string) =>
  ownerAdmitOrPend({ workspaceId: WS, potHomeSlug: HIVE, joiner: joiner(i, devicePubkey) }, deps());

/** The roster as the database holds it. */
async function memberCount(): Promise<number> {
  return (await listHiveMembers(WS, HIVE, sql)).length;
}

let policyVersion = 0;

/** Write the owner's policy straight to the store (the read path the admission gate uses). */
async function setPolicy(policy: HivePolicy): Promise<void> {
  policyVersion += 1;
  await upsertHivePolicyRow(
    {
      workspaceId: WS,
      potHomeSlug: HIVE,
      policyJson: canonicalizeHivePolicy(policy),
      ownerPubkey: 'test-owner-pk',
      signature: 'test-sig',
      policyVersion,
    },
    sql,
  );
}

/** Fill the hive with members 0..count-1, asserting each join is admitted as a new member. */
async function fillTo(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const out = await admit(i);
    expect(out).toMatchObject({ action: 'admitted', reason: 'policy_admit' });
  }
  expect(await memberCount()).toBe(count);
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  vi.stubEnv(RELEASE_ENV, '1');
  await insertHiveIfAbsent(
    {
      workspaceId: WS,
      homeSlug: HIVE,
      pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64,
      keychainId: hiveKeychainId(WS, HIVE),
    },
    sql,
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await sql.unsafe(
    `TRUNCATE harness_shared.pot_pending_joins, harness_shared.pot_members,
             harness_shared.pot_policy, harness_shared.pots,
             harness_shared.substrate_outbox CASCADE`,
  );
});

describe('R-8: a hive refuses a join beyond the v1 size limit', () => {
  it('R-8: the limit is a positive member count declared by the scope contract', () => {
    expect(Number.isInteger(N)).toBe(true);
    expect(N).toBeGreaterThan(1);
  });

  it('R-8: joins bringing the hive to N-1 and to N members succeed', async () => {
    await fillTo(N - 1);
    expect(await admit(N - 1)).toMatchObject({ action: 'admitted', reason: 'policy_admit' });
    expect(await memberCount()).toBe(N);
  });

  it('R-8: the join that would make N+1 members is refused with the size-limit reason', async () => {
    await fillTo(N);
    const out = await admit(N);
    expect(out).toMatchObject({ action: 'refuse', reason: 'hive_size_limit' });
    expect(out.action === 'refuse' ? out.detail : '').toContain(`limit is ${N}`);
    expect(await memberCount()).toBe(N);
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
  });

  it('R-8: an existing member reconnecting at N is accepted without using a slot', async () => {
    await fillTo(N);
    expect(await admit(0)).toMatchObject({ action: 'admitted', reason: 'already_member' });
    expect(await admit(1, 'dev-1-second-device')).toMatchObject({ action: 'admitted', reason: 'already_member' });
    expect(await memberCount()).toBe(N);
    // The slot was not consumed: the next new joiner is still the one refused.
    expect(await admit(N)).toMatchObject({ action: 'refuse', reason: 'hive_size_limit' });
  });

  it('R-8: under approval mode a full hive records no pending request', async () => {
    await fillTo(N);
    await setPolicy({ membership: 'approval' });
    expect(await admit(N)).toMatchObject({ action: 'refuse', reason: 'hive_size_limit' });
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
  });

  it('R-8: an approval that would make N+1 members is refused and the request stays pending', async () => {
    await fillTo(N - 1);
    await setPolicy({ membership: 'approval' });
    const late = joiner(N);
    expect(await ownerAdmitOrPend({ workspaceId: WS, potHomeSlug: HIVE, joiner: late }, deps())).toMatchObject({
      action: 'pending',
    });
    // The last slot fills while the request waits (an open join under the same limit).
    await setPolicy({ membership: 'open' });
    expect(await admit(N - 1)).toMatchObject({ action: 'admitted', reason: 'policy_admit' });
    expect(await memberCount()).toBe(N);

    const decided = await approvePendingJoin(
      { workspaceId: WS, potHomeSlug: HIVE, githubUserId: late.githubUserId, decidedByGithubUserId: 1 },
      deps(),
    );
    expect(decided).toMatchObject({ ok: false, code: 'hive_size_limit' });
    expect(await memberCount()).toBe(N);
    expect((await getPendingJoin(WS, HIVE, late.githubUserId, sql))?.status).toBe('pending');
  });

  it('R-8 control: outside the release build the N+1th joiner is admitted', async () => {
    await fillTo(N);
    vi.stubEnv(RELEASE_ENV, '');
    expect(await admit(N)).toMatchObject({ action: 'admitted', reason: 'policy_admit' });
    expect(await memberCount()).toBe(N + 1);
  });
});
