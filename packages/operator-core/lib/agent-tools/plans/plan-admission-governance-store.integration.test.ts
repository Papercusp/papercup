import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { insertHiveIfAbsent } from '../../hive-store';
import { listHiveSettings } from '../../hive-settings-store';
import { upsertHivePolicyRow } from '../../hive-policy-store';
import { canonicalizeHivePolicy, hivePolicySignedBytes, type HivePolicy } from '../../hive-policy-schema';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { buildHiveSettingsProjection } from '../../sync/hyperbee/projections/hive-settings';
import { authenticateGovernanceEvent, governanceAuthorityHash, governanceEventSigningBytes,
  governanceVoteSigningBytes, type GovernanceSigningAuthority } from './governance-authentication';
import { ingestGovernanceEvents, selectFederatableEvents,
  type FederatedGovernanceEvent, type GovernanceEventBody } from './governance-federation';
import { createGovernanceRound, finalizeGovernanceRound, type GovernanceVoteEvent } from './governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';
import { createPlanAdmissionCertificateSource } from './plan-admission-certificate-source';
import { appendPlanAdmissionGovernanceEvent, planAdmissionGovernanceEventSettingKey,
  readPlanAdmissionGovernanceSnapshot, resolvePlanAdmissionGovernanceAuthority } from './plan-admission-governance-store';

const WORKSPACE = 'governance-security-integration';
const POT = 'signed-pot';
const NOW = 1_700_000_000_000;

/** Real signatures throughout; only scope lookup and the clock are fixture seams.
 * Each replica has its own fully migrated database. The production policy reader,
 * immutable store, signature verifier, certificate reconstruction and PG projection
 * run unchanged. Transport delivery is controlled here to model a partition; the
 * real-DHT suite separately verifies network delivery.
 */
describe('signed governance partition and immutable persistence (real PG)', () => {
  let replicas: [OrgTestDb, OrgTestDb];
  const owner = generateEd25519KeypairDer();
  const voterA = generateEd25519KeypairDer();
  const voterB = generateEd25519KeypairDer();
  const authority: GovernanceSigningAuthority = {
    potId: POT, policy: DEFAULT_PLAN_ADMISSION_POLICY,
    members: [
      { memberId: 'a', publicKey: voterA.pubkeyBase64, keyEpoch: 1, originPeerIds: ['peer-a'],
        roles: ['round-open', 'vote', 'finalize', 'pause', 'resume', 'revoke'] },
      { memberId: 'b', publicKey: voterB.pubkeyBase64, keyEpoch: 1, originPeerIds: ['peer-b'], roles: ['vote'] },
    ],
  };
  const policy: HivePolicy = { governance: {
    planAdmission: authority.policy, signingAuthority: { members: authority.members },
  } };
  const deps = { resolvePotScope: async () => POT, nowMs: () => NOW };

  async function persistPolicy(db: OrgTestDb, signatureOverride?: string) {
    const policyJson = canonicalizeHivePolicy(policy);
    const signature = signWithPrivateKeyDer(owner.privateKeyDer, hivePolicySignedBytes({
      workspaceId: WORKSPACE, potHomeSlug: POT, policyVersion: 1, canonicalPolicyJson: policyJson,
    })).toString('base64');
    await upsertHivePolicyRow({ workspaceId: WORKSPACE, potHomeSlug: POT, policyJson,
      ownerPubkey: owner.pubkeyBase64, policyVersion: 1, signature: signatureOverride ?? signature }, db.adminSql);
  }

  beforeAll(async () => {
    const left = await createOrgTestDb();
    try {
      replicas = [left, await createOrgTestDb()];
      for (const db of replicas) await insertHiveIfAbsent({ workspaceId: WORKSPACE, homeSlug: POT,
        pubkeyBase64: owner.pubkeyBase64, keychainId: 'isolated-test-owner' }, db.adminSql);
    } catch (error) {
      await left.cleanup();
      throw error;
    }
  }, 120_000);

  beforeEach(async () => {
    for (const db of replicas) {
      await db.adminSql`DELETE FROM harness_shared.pot_settings WHERE workspace_id = ${WORKSPACE}`;
      await persistPolicy(db);
    }
  });

  afterAll(async () => {
    if (!replicas) return;
    // Verify teardown independently: cleanup() deliberately swallows drop errors.
    const url = new URL(replicas[0].adminDsn);
    url.pathname = '/postgres';
    const maintenance = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await Promise.all(replicas.map(db => db.cleanup()));
      const remaining = await maintenance`SELECT datname FROM pg_database
        WHERE datname IN (${replicas[0].dbName}, ${replicas[1].dbName})`;
      expect(remaining).toHaveLength(0);
    } finally {
      await maintenance.end({ timeout: 5 });
    }
  }, 20_000);

  function fixture() {
    const created = createGovernanceRound({ roundId: 'round', planRevisionHash: 'revision',
      policyVersion: authority.policy.policyVersion, eligibleMemberIds: ['a', 'b'],
      createdAtMs: NOW - 1_000, authorityHash: governanceAuthorityHash(authority) });
    if (!created.ok) throw new Error(created.detail);
    const round = created.value;
    function sign(eventId: string, body: GovernanceEventBody,
      over: Partial<Omit<FederatedGovernanceEvent, 'signature'>> = {}): FederatedGovernanceEvent {
      const memberId = body.kind === 'vote' ? body.vote.memberId : 'a';
      const key = memberId === 'b' ? voterB : voterA;
      const unsigned = { eventId, potId: POT, roundId: round.roundId,
        originPeerId: memberId === 'b' ? 'peer-b' : 'peer-a', occurredAtMs: NOW,
        body, authorization: { memberId, keyEpoch: 1 }, ...over };
      return { ...unsigned, signature: signWithPrivateKeyDer(key.privateKeyDer,
        governanceEventSigningBytes(unsigned)).toString('base64') };
    }
    const votes: GovernanceVoteEvent[] = ['a', 'b'].map((memberId, i) => {
      const unsigned = { eventId: `vote-${memberId}`, roundId: round.roundId, memberId,
        choice: 'approve' as const, sequence: i + 1, keyEpoch: 1 };
      return { ...unsigned, signature: signWithPrivateKeyDer((i === 0 ? voterA : voterB).privateKeyDer,
        governanceVoteSigningBytes(authority, round, unsigned)).toString('base64') };
    });
    const finalized = finalizeGovernanceRound({ round, events: votes, policy: authority.policy,
      members: authority.members, nowMs: NOW });
    if (!finalized.ok) throw new Error(finalized.detail);
    expect(finalized.value.admitted).toBe(true);
    return { round, votes, sign, certificate: finalized.value,
      events: [sign('opened', { kind: 'round-open', round }),
        ...votes.map(vote => sign(`envelope-${vote.memberId}`, { kind: 'vote', vote })),
        sign('finalized', { kind: 'finalize', certificate: finalized.value })] };
  }

  const scope = { workspaceId: WORKSPACE, potHomeSlug: POT };
  const append = (db: OrgTestDb, event: FederatedGovernanceEvent) =>
    appendPlanAdmissionGovernanceEvent({ ...scope, event }, db.adminSql, deps);
  const snapshot = (db: OrgTestDb) => readPlanAdmissionGovernanceSnapshot(scope, db.adminSql, deps);
  const resolve = (db: OrgTestDb) => createPlanAdmissionCertificateSource({
    resolvePotHomeSlug: async () => POT,
    readSnapshot: input => readPlanAdmissionGovernanceSnapshot(input, db.adminSql, deps),
    resolveAuthority: input => resolvePlanAdmissionGovernanceAuthority(input, db.adminSql),
  }).resolveFinalization({ slug: 'plan', door: 'start', opts: { workspaceId: WORKSPACE, harnessSlug: POT },
    planRevisionHash: 'revision', policy: authority.policy, nowMs: NOW });

  async function deliver(db: OrgTestDb, incoming: readonly FederatedGovernanceEvent[]) {
    const f = fixture();
    const trusted = await resolvePlanAdmissionGovernanceAuthority({ ...scope, potId: POT }, db.adminSql);
    expect(trusted).toEqual(authority);
    const result = ingestGovernanceEvents({
      boundary: { potId: POT, visibility: 'shared', memberPeerIds: ['peer-a', 'peer-b'] },
      known: (await snapshot(db)).events, incoming,
      verifySignature: event => authenticateGovernanceEvent({ authority: trusted!, event,
        round: f.round, nowMs: NOW }).ok,
    });
    const projection = buildHiveSettingsProjection({ workspaceId: WORKSPACE, harnessSlug: POT, sql: db.adminSql });
    for (const event of result.accepted) await projection.writeToPg({ harness_slug: POT,
      setting_key: planAdmissionGovernanceEventSettingKey(event), value: JSON.stringify(event) },
    { origin: 'remote', authorPubkey: event.originPeerId === 'peer-b' ? voterB.pubkeyBase64 : voterA.pubkeyBase64, ts: NOW });
    return result;
  }

  it('refuses partial replicas then reconstructs the same signed certificate after partition recovery', async () => {
    const f = fixture(), [left, right] = replicas;
    for (const db of replicas) await append(db, f.events[0]!);
    await append(left, f.events[1]!);
    await append(left, f.events[3]!);
    await append(right, f.events[2]!);
    expect((await resolve(left)).certificate).toBeNull();
    expect((await resolve(right)).certificate).toBeNull();
    const leftEvents = (await snapshot(left)).events;
    const rightEvents = (await snapshot(right)).events;
    expect((await deliver(left, rightEvents)).dropped).toEqual([]);
    expect((await deliver(right, [...leftEvents].reverse())).dropped).toEqual([]);
    for (const db of replicas) {
      const stored = await snapshot(db);
      expect(stored.integrityErrors).toEqual([]);
      expect(stored.events).toHaveLength(4);
      expect((await resolve(db)).certificate).toEqual(f.certificate);
    }
  });

  it('persists exact replay once and refuses a signed local rewrite of an immutable event id', async () => {
    const f = fixture(), db = replicas[0];
    for (const event of f.events) await append(db, event);
    for (const event of f.events) await append(db, event);
    expect((await listHiveSettings(WORKSPACE, POT, db.adminSql))).toHaveLength(4);
    expect((await deliver(db, f.events)).accepted).toEqual([]);
    const rewritten = f.sign('envelope-a', { kind: 'vote', vote: f.votes[0]! }, { occurredAtMs: NOW - 1 });
    await expect(append(db, rewritten)).rejects.toThrow(/immutable conflict/);
    expect((await snapshot(db)).events).toHaveLength(4);
    expect((await resolve(db)).certificate).toEqual(f.certificate);
  });

  it('refuses authentic foreign/private operations and forged or stale-epoch peer records before persistence', async () => {
    const f = fixture(), db = replicas[0];
    await append(db, f.events[0]!);
    const ballot = f.events[1]!;
    for (const invalid of [
      { ...ballot, signature: 'forged' },
      { ...ballot, authorization: undefined },
      f.sign('inner-forgery', { kind: 'vote', vote: { ...f.votes[0]!, signature: 'forged' } }),
      f.sign('stale', { kind: 'vote', vote: f.votes[0]! }, { authorization: { memberId: 'a', keyEpoch: 2 } }),
      f.sign('foreign', { kind: 'vote', vote: f.votes[0]! }, { potId: 'foreign-pot' }),
      f.sign('outsider', { kind: 'vote', vote: f.votes[0]! }, { originPeerId: 'outsider' }),
    ]) {
      const refused = await deliver(db, [invalid]);
      expect(refused.accepted).toEqual([]);
      expect(refused.dropped).toHaveLength(1);
    }
    const privateBoundary = { potId: POT, visibility: 'private' as const, memberPeerIds: ['peer-a'] };
    expect(selectFederatableEvents({ boundary: privateBoundary, events: f.events, toPeerId: 'peer-b' })).toEqual([]);
    expect(selectFederatableEvents({ boundary: privateBoundary, events: f.events, toPeerId: 'peer-a' })).toHaveLength(4);
    const refusedPrivate = ingestGovernanceEvents({ boundary: privateBoundary, known: [], incoming: [f.events[2]!],
      verifySignature: event => authenticateGovernanceEvent({ authority, event, round: f.round, nowMs: NOW }).ok,
    });
    expect(refusedPrivate.accepted).toEqual([]);
    expect(refusedPrivate.dropped).toMatchObject([{ reason: 'non-member-peer' }]);
    expect((await listHiveSettings(WORKSPACE, POT, db.adminSql))).toHaveLength(1);
    expect((await resolve(db)).certificate).toBeNull();
  });

  it('detects a remote signed immutable conflict in PostgreSQL and refuses certificate consumption', async () => {
    const f = fixture(), db = replicas[0];
    for (const event of f.events) await append(db, event);
    const conflict = f.sign('envelope-a', { kind: 'vote', vote: f.votes[0]! }, { occurredAtMs: NOW - 1 });
    // Separate content-addressed keys model concurrent peer writes, which cannot
    // use the local append's prior-snapshot check as a distributed lock.
    const projection = buildHiveSettingsProjection({ workspaceId: WORKSPACE, harnessSlug: POT, sql: db.adminSql });
    await projection.writeToPg({ harness_slug: POT, setting_key: planAdmissionGovernanceEventSettingKey(conflict),
      value: JSON.stringify(conflict) }, { origin: 'remote', authorPubkey: voterA.pubkeyBase64, ts: NOW });
    expect((await listHiveSettings(WORKSPACE, POT, db.adminSql))).toHaveLength(5);
    expect((await snapshot(db)).conflictedRoundIds.has(f.round.roundId)).toBe(true);
    expect((await resolve(db)).certificate).toBeNull();
    expect((await snapshot(db)).integrityErrors).toEqual([`immutable event conflict: ${conflict.eventId}`]);
  });

  it('reauthenticates stored policy and ballots rather than trusting a persisted approval', async () => {
    const f = fixture(), db = replicas[0];
    for (const event of f.events) await append(db, event);
    expect((await resolve(db)).certificate).toEqual(f.certificate);
    await persistPolicy(db, Buffer.alloc(64).toString('base64'));
    expect(await resolvePlanAdmissionGovernanceAuthority({ ...scope, potId: POT }, db.adminSql)).toBeNull();
    expect((await resolve(db)).certificate).toBeNull();
    await persistPolicy(db);
    const forged = { ...f.events[1]!, signature: Buffer.alloc(64).toString('base64') };
    await db.adminSql`UPDATE harness_shared.pot_settings SET value = ${JSON.stringify(forged)}
      WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${POT}
        AND setting_key = ${planAdmissionGovernanceEventSettingKey(forged)}`;
    expect((await snapshot(db)).integrityErrors.join(';')).toContain('unverified-signature');
    expect((await resolve(db)).certificate).toBeNull();
  });
});
