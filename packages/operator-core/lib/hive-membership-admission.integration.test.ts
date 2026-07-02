/**
 * Release-gate INTEGRATION coverage for the P-MEMBER admission boundary
 * (hive-membership-admission.ts) against REAL Postgres — the sibling of the
 * injected-fakes unit test (hive-membership-admission.test.ts). Where the unit
 * test pins the WIRING (which seam is called), this exercises the orchestration
 * end-to-end through the REAL stores on a fully-migrated schema, so a schema /
 * store / federation-trigger regression that the mock can't see turns it RED.
 *
 * Boundary covered (shared-hive-public-release-2026-06-22, Lane T3):
 *   - OPEN (or absent policy) ⇒ auto-admit; NO pending row, NO member row.
 *   - APPROVAL ⇒ a real pending row lands (devices captured) AND federates
 *     (substrate_outbox put, scoped to the Hive home slug → reaches the owner).
 *   - owner APPROVE ⇒ the joiner + their captured devices land in hive_members
 *     (binding 'verified') and the pending row flips 'approved'.
 *   - owner DENY ⇒ the pending row flips 'denied' (reason logged); the joiner is
 *     NEVER trust-admitted (no hive_members row).
 *   - a DENIED joiner's re-request stays denied (the store preserves the owner's
 *     decision — a denied joiner can't re-open the queue).
 *   - BAN: a banned github id is REFUSED admission even in open mode; banMember
 *     records the ban in the policy store (+ fires the revoke leg) so the real
 *     admission gate refuses; unbanMember restores admission. (revoke:false bans
 *     policy-only.)
 *
 * Seam notes: the admission fns thread `deps.sql` into every store, so we pass the
 * migrated admin client and the REAL recordPendingJoin / getPendingJoin /
 * setPendingJoinDecision / upsertHiveMember / getHivePolicy run against it. The
 * Ed25519 SIGNING of a policy is the policy-author's concern (covered there +ban
 * unit test) — here banMember is driven through a PG-backed mutate seam so the
 * focus stays on the admission/ban DATA + ENFORCEMENT round-trip, not the crypto.
 *
 * Run: cd packages/operator-core && npx vitest run lib/hive-membership-admission.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import {
  evaluateJoinAdmission,
  approvePendingJoin,
  denyPendingJoin,
  ownerAdmitOrPend,
} from './hive-membership-admission';
import { getPendingJoin, listPendingJoins } from './hive-pending-joins-store';
import { getHiveMember, listHiveMembers } from './hive-membership-store';
import { getHivePolicy, upsertHivePolicyRow } from './hive-policy-store';
import { canonicalizeHivePolicy, type HivePolicy } from './hive-policy-schema';
import { banMember, unbanMember } from './hive-moderation';
import type { AuthorHivePolicyResult } from './hive-policy-author';
import type { RevokeHiveContributorResult } from './hive-revoke-contributor';
import { insertHiveIfAbsent } from './hive-store';
import { generateEd25519KeypairDer } from './identity/ed25519';
import { hiveKeychainId } from './identity/hive-keypair';
import type { DeviceAttestationEntry } from './harness/contributor-row-types';

const WS = 'ws-admission';
const HIVE = 'acme';
const OWNER_ID = 9;

function dev(pubkey: string): DeviceAttestationEntry {
  return {
    device_pubkey: pubkey,
    gist_id: 'g',
    gist_url: 'u',
    device_label: 'd',
    created_at: 1,
    signature_by_device: 's',
  };
}

const alice = {
  githubUserId: 1001,
  githubUsername: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  deviceAttestations: [dev('devA')],
};

let db: OrgTestDb;
let sql: Sql;

/** Seed the Hive identity row (FK parent for hive_members on approval). */
async function seedHive(slug = HIVE, ws = WS): Promise<void> {
  await insertHiveIfAbsent(
    {
      workspaceId: ws,
      homeSlug: slug,
      pubkeyBase64: generateEd25519KeypairDer().pubkeyBase64,
      keychainId: hiveKeychainId(ws, slug),
    },
    sql,
  );
}

/** Write the owner's policy directly to the store (the READ path getHivePolicy
 *  consumes — verification happens at projection-apply, not on read, so a raw
 *  store row faithfully represents "the owner authored this policy"). */
async function setPolicy(policy: HivePolicy, version = 1, ws = WS, slug = HIVE): Promise<void> {
  await upsertHivePolicyRow(
    {
      workspaceId: ws,
      hiveHomeSlug: slug,
      policyJson: canonicalizeHivePolicy(policy),
      ownerPubkey: 'test-owner-pk',
      signature: 'test-sig',
      policyVersion: version,
    },
    sql,
  );
}

/** A PG-backed mutateHivePolicy seam: read → mutate → version-bumped raw upsert.
 *  Faithful to the real read-modify-write minus the Ed25519 signing (the author's
 *  own surface), so banMember's two-leg composition runs against real PG. */
async function pgMutate(input: {
  workspaceId: string;
  hiveHomeSlug: string;
  mutate: (p: HivePolicy) => HivePolicy;
}): Promise<AuthorHivePolicyResult> {
  const current = await getHivePolicy(input.workspaceId, input.hiveHomeSlug, sql);
  const next = input.mutate(current?.policy ?? {});
  const resolved = await upsertHivePolicyRow(
    {
      workspaceId: input.workspaceId,
      hiveHomeSlug: input.hiveHomeSlug,
      policyJson: canonicalizeHivePolicy(next),
      ownerPubkey: current?.ownerPubkey ?? 'test-owner-pk',
      signature: 'test-sig',
      policyVersion: (current?.policyVersion ?? 0) + 1,
    },
    sql,
  );
  return { ok: true, policy: resolved };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql; // superuser: RLS-bypass; the stores carry explicit WHERE workspace_id.
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await sql.unsafe(
    `TRUNCATE harness_shared.hive_pending_joins, harness_shared.hive_members,
             harness_shared.hive_policy, harness_shared.hives,
             harness_shared.substrate_outbox CASCADE`,
  );
});

describe('admission — OPEN mode (or absent policy) ⇒ auto-admit', () => {
  it('absent policy ⇒ admit; NO pending row, NO member row', async () => {
    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out).toEqual({ outcome: 'admit' });
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
    expect(await listHiveMembers(WS, HIVE, sql)).toHaveLength(0);
  });

  it("explicit membership:'open' ⇒ admit; no pending recorded", async () => {
    await setPolicy({ membership: 'open' });
    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out.outcome).toBe('admit');
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
  });
});

describe('admission — APPROVAL mode ⇒ pending → owner decides', () => {
  it('approval ⇒ pending; a real row lands with the joiner devices AND federates to the owner', async () => {
    await setPolicy({ membership: 'approval' });
    await sql.unsafe('DELETE FROM harness_shared.substrate_outbox'); // isolate the pending-join capture

    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out.outcome).toBe('pending');

    // The pending row is real, status 'pending', devices captured for approval.
    const row = await getPendingJoin(WS, HIVE, alice.githubUserId, sql);
    expect(row).toMatchObject({ githubUserId: 1001, githubUsername: 'alice', status: 'pending' });
    expect(row?.deviceAttestations[0]?.device_pubkey).toBe('devA');
    // NOT trust-admitted yet.
    expect(await getHiveMember(WS, HIVE, alice.githubUserId, sql)).toBeNull();

    // It federates: one substrate_outbox put keyed by github id, scoped to the Hive home slug.
    const outbox = (await sql.unsafe(
      `SELECT table_name, op, key, harness_slug FROM harness_shared.substrate_outbox
        WHERE table_name = 'hive_pending_joins'`,
    )) as unknown as Array<{ table_name: string; op: string; key: string; harness_slug: string }>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ op: 'put', key: String(alice.githubUserId), harness_slug: HIVE });
  });

  it('owner APPROVE ⇒ joiner + captured devices land in hive_members (verified); pending → approved', async () => {
    await seedHive();
    await setPolicy({ membership: 'approval' });
    await evaluateJoinAdmission({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });

    const res = await approvePendingJoin(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: alice.githubUserId, decidedByGithubUserId: OWNER_ID },
      { sql },
    );
    expect(res).toMatchObject({ ok: true, status: 'approved' });

    // The joiner is now a trust-set member, with the devices captured at request time.
    const member = await getHiveMember(WS, HIVE, alice.githubUserId, sql);
    expect(member).toMatchObject({ githubUserId: 1001, githubUsername: 'alice', bindingStatus: 'verified' });
    expect(member?.deviceAttestations[0]?.device_pubkey).toBe('devA');

    // The pending row records the owner decision.
    const pending = await getPendingJoin(WS, HIVE, alice.githubUserId, sql);
    expect(pending).toMatchObject({ status: 'approved', decidedByGithubUserId: OWNER_ID });
  });

  it('owner DENY ⇒ pending → denied (reason logged); joiner NEVER trust-admitted', async () => {
    await seedHive();
    await setPolicy({ membership: 'approval' });
    await evaluateJoinAdmission({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });

    const res = await denyPendingJoin(
      {
        workspaceId: WS,
        hiveHomeSlug: HIVE,
        githubUserId: alice.githubUserId,
        decidedByGithubUserId: OWNER_ID,
        reason: 'spam',
      },
      { sql },
    );
    expect(res).toMatchObject({ ok: true, status: 'denied' });

    const pending = await getPendingJoin(WS, HIVE, alice.githubUserId, sql);
    expect(pending).toMatchObject({ status: 'denied', reason: 'spam', decidedByGithubUserId: OWNER_ID });
    // The deny is logged but NEVER lands a member row.
    expect(await getHiveMember(WS, HIVE, alice.githubUserId, sql)).toBeNull();
    expect(await listHiveMembers(WS, HIVE, sql)).toHaveLength(0);
  });

  it('approve with NO pending row ⇒ no_pending; never trust-admits', async () => {
    await seedHive();
    const res = await approvePendingJoin(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: 4040, decidedByGithubUserId: OWNER_ID },
      { sql },
    );
    expect(res).toEqual({ ok: false, code: 'no_pending' });
    expect(await getHiveMember(WS, HIVE, 4040, sql)).toBeNull();
  });

  it('a DENIED joiner who re-requests STAYS denied (the owner decision is preserved)', async () => {
    await setPolicy({ membership: 'approval' });
    await evaluateJoinAdmission({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });
    await denyPendingJoin(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: alice.githubUserId, decidedByGithubUserId: OWNER_ID, reason: 'no' },
      { sql },
    );

    // Re-request: the joiner tries again. It must NOT re-open the queue.
    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out.outcome).toBe('pending'); // policy still approval-mode
    const row = await getPendingJoin(WS, HIVE, alice.githubUserId, sql);
    expect(row?.status).toBe('denied'); // preserved — a re-request can't flip it back to pending
  });

  // WI-565 audit gap: recordPendingJoin's own doc comment claims a still-PENDING
  // re-request is idempotent (ON CONFLICT DO UPDATE refreshes identity/device
  // fields, never resets/duplicates status) — but nothing asserted it directly.
  // The PK is (workspace_id, harness_slug, github_user_id), so a bug here would
  // either duplicate the row (constraint violation) or silently reset status.
  it('double-join idempotency: a re-request while STILL PENDING refreshes fields, stays one row, status stays pending', async () => {
    await setPolicy({ membership: 'approval' });
    const first = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(first.outcome).toBe('pending');

    // Re-request with a NEW device + display name (e.g. joiner installed a second
    // machine before the owner decided) — must refresh, not duplicate or reset.
    const second = await evaluateJoinAdmission(
      {
        workspaceId: WS,
        hiveHomeSlug: HIVE,
        joiner: { ...alice, displayName: 'Alice B.', deviceAttestations: [dev('devA'), dev('devB')] },
      },
      { sql },
    );
    expect(second.outcome).toBe('pending');

    const rows = await listPendingJoins(WS, HIVE, { status: null }, sql);
    expect(rows).toHaveLength(1); // no duplicate row — the PK + ON CONFLICT held
    const row = await getPendingJoin(WS, HIVE, alice.githubUserId, sql);
    expect(row?.status).toBe('pending'); // still awaiting the owner, not silently reset/lost
    expect(row?.displayName).toBe('Alice B.'); // identity fields refreshed
    expect(row?.deviceAttestations.map((d) => d.device_pubkey)).toEqual(['devA', 'devB']); // devices refreshed
  });

  it('an APPROVED joiner who re-requests STAYS approved (a re-request cannot un-admit a member)', async () => {
    await seedHive();
    await setPolicy({ membership: 'approval' });
    await evaluateJoinAdmission({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });
    await approvePendingJoin(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: alice.githubUserId, decidedByGithubUserId: OWNER_ID },
      { sql },
    );

    // Re-request after approval (e.g. the joiner's client retries the join call).
    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out.outcome).toBe('pending'); // policy is still approval-mode — the GATE re-runs...
    const row = await getPendingJoin(WS, HIVE, alice.githubUserId, sql);
    expect(row?.status).toBe('approved'); // ...but the STORED decision is preserved, not reset
    // The member row is untouched by the re-request (evaluateJoinAdmission never
    // calls upsertHiveMember itself — only the trust-set write matters here).
    expect(await getHiveMember(WS, HIVE, alice.githubUserId, sql)).toMatchObject({ bindingStatus: 'verified' });
  });
});

describe('ban — refused re-join even in open mode; unban restores', () => {
  it('a banned github id is REFUSED in open mode (no pending, no member)', async () => {
    await setPolicy({ membership: 'open', moderation: { bannedGithubIds: [String(alice.githubUserId)] } });
    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out).toEqual({ outcome: 'refuse', reason: 'banned' });
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
    expect(await getHiveMember(WS, HIVE, alice.githubUserId, sql)).toBeNull();
  });

  it('banMember records the ban in the policy store (+ fires revoke); admission then refuses', async () => {
    await setPolicy({ membership: 'open' }); // a pre-existing open policy
    const revoke = vi.fn(
      async (): Promise<RevokeHiveContributorResult> => ({ ok: true, revokedPubkeys: ['devA'], live: false }),
    );

    const res = await banMember(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: alice.githubUserId },
      { mutateHivePolicy: pgMutate as never, revokeHiveContributor: revoke as never },
    );
    expect(res.policy.ok).toBe(true);
    expect(revoke).toHaveBeenCalledWith({
      workspaceId: WS,
      hiveHomeSlug: HIVE,
      githubUserId: alice.githubUserId,
    });

    // The ban is persisted in the real policy row...
    const stored = await getHivePolicy(WS, HIVE, sql);
    expect(stored?.policy.moderation?.bannedGithubIds).toContain(String(alice.githubUserId));
    // ...and the real admission gate now refuses the join.
    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out).toEqual({ outcome: 'refuse', reason: 'banned' });
  });

  it('unbanMember lifts the ban ⇒ admission admits again', async () => {
    await setPolicy({ membership: 'open', moderation: { bannedGithubIds: [String(alice.githubUserId)] } });
    // sanity: refused while banned
    expect((await evaluateJoinAdmission({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql })).outcome).toBe(
      'refuse',
    );

    const res = await unbanMember(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: alice.githubUserId },
      { mutateHivePolicy: pgMutate as never },
    );
    expect(res.ok).toBe(true);

    const stored = await getHivePolicy(WS, HIVE, sql);
    expect(stored?.policy.moderation?.bannedGithubIds ?? []).not.toContain(String(alice.githubUserId));
    const out = await evaluateJoinAdmission(
      { workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice },
      { sql },
    );
    expect(out.outcome).toBe('admit');
  });

  it('banMember with revoke:false records the ban (policy-only) but SKIPS the revoke leg', async () => {
    await setPolicy({ membership: 'open' });
    const revoke = vi.fn();
    const res = await banMember(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: alice.githubUserId, revoke: false },
      { mutateHivePolicy: pgMutate as never, revokeHiveContributor: revoke as never },
    );
    expect(res.revoke).toEqual({ skipped: true });
    expect(revoke).not.toHaveBeenCalled();
    const stored = await getHivePolicy(WS, HIVE, sql);
    expect(stored?.policy.moderation?.bannedGithubIds).toContain(String(alice.githubUserId));
    // policy-only ban still enforces at admission.
    expect((await evaluateJoinAdmission({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql })).outcome).toBe(
      'refuse',
    );
  });
});

// WI-639: the OWNER admission seam (boot.ts drainAdmissionQueue) now routes through
// ownerAdmitOrPend instead of an unconditional upsertHiveMember. This exercises that
// decision end-to-end on real PG — the live-path behavior boot.ts depends on.
describe('ownerAdmitOrPend — owner admission seam routes off the policy (WI-639)', () => {
  it('OPEN / absent policy ⇒ trust-admit: a real hive_members row, NO pending', async () => {
    await seedHive();
    const out = await ownerAdmitOrPend({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });
    expect(out).toMatchObject({ action: 'admitted', reason: 'policy_admit' });
    const member = await getHiveMember(WS, HIVE, alice.githubUserId, sql);
    expect(member).toMatchObject({ githubUserId: 1001, bindingStatus: 'verified' });
    expect(member?.deviceAttestations[0]?.device_pubkey).toBe('devA');
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
  });

  it("APPROVAL ⇒ pending: records a federated pending row, NO member (the gap this fix closes)", async () => {
    await seedHive();
    await setPolicy({ membership: 'approval' });
    await sql.unsafe('DELETE FROM harness_shared.substrate_outbox'); // isolate the pending-join capture

    const out = await ownerAdmitOrPend({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });
    expect(out.action).toBe('pending');

    // A pending row exists; the joiner is NOT yet a member.
    const row = await getPendingJoin(WS, HIVE, alice.githubUserId, sql);
    expect(row).toMatchObject({ githubUserId: 1001, status: 'pending' });
    expect(await getHiveMember(WS, HIVE, alice.githubUserId, sql)).toBeNull();

    // The pending request federates (one outbox put keyed by github id, Hive-scoped).
    const outbox = (await sql.unsafe(
      `SELECT op, key, harness_slug FROM harness_shared.substrate_outbox WHERE table_name = 'hive_pending_joins'`,
    )) as unknown as Array<{ op: string; key: string; harness_slug: string }>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ op: 'put', key: String(alice.githubUserId), harness_slug: HIVE });
  });

  it('APPROVAL → ownerAdmitOrPend (pending) → owner APPROVE ⇒ joiner becomes a member', async () => {
    await seedHive();
    await setPolicy({ membership: 'approval' });
    expect((await ownerAdmitOrPend({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql })).action).toBe(
      'pending',
    );
    const res = await approvePendingJoin(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: alice.githubUserId, decidedByGithubUserId: OWNER_ID },
      { sql },
    );
    expect(res).toMatchObject({ ok: true, status: 'approved' });
    expect(await getHiveMember(WS, HIVE, alice.githubUserId, sql)).toMatchObject({ bindingStatus: 'verified' });
  });

  it('ALREADY a member ⇒ refresh (re-upsert), never a second pending row, even under approval', async () => {
    await seedHive();
    // First admit (open) makes alice a member.
    await ownerAdmitOrPend({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });
    // Now flip to approval + re-run (a reconnect): she must STAY a member, no pending.
    await setPolicy({ membership: 'approval' });
    const out = await ownerAdmitOrPend({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });
    expect(out).toMatchObject({ action: 'admitted', reason: 'already_member' });
    expect(await listHiveMembers(WS, HIVE, sql)).toHaveLength(1);
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
  });

  it('banned ⇒ refuse: no member, no pending', async () => {
    await seedHive();
    await setPolicy({ membership: 'open', moderation: { bannedGithubIds: [String(alice.githubUserId)] } });
    const out = await ownerAdmitOrPend({ workspaceId: WS, hiveHomeSlug: HIVE, joiner: alice }, { sql });
    expect(out).toEqual({ action: 'refuse', reason: 'banned' });
    expect(await getHiveMember(WS, HIVE, alice.githubUserId, sql)).toBeNull();
    expect(await listPendingJoins(WS, HIVE, { status: null }, sql)).toHaveLength(0);
  });
});
