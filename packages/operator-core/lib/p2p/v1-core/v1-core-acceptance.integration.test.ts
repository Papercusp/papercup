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
 * R-1, R-3, R-4, R-5 and the fault set (P-002) run several real substrate peers of one hive
 * in this process through the multi-peer harness (./_multi-peer-harness). Every harness in
 * this file shares ONE run ledger (RUN), so the fault-set case at the end reads the receipts
 * every case's faults left under one run id. Rows are always read straight from each peer's
 * own database, never from what the code under test reports.
 *
 * Until P-004 delivers the product's join-complete state, `settle()` (every live peer holds
 * every other live peer's full own log and nothing is pending) stands in for it.
 *
 * Later plan items extend this file with R-6 (P-003) and R-9 (P-004).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { pollUntil } from '../../sync/hyperbee/__tests__/_hive-substrate-rig';
import {
  createMultiPeerHarness,
  harnessAfterEach,
  type CanonicalDump,
  type FaultKind,
  type MultiPeerHarness,
  type RunLedger,
} from './_multi-peer-harness';
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

// Each harness peer boots inside its own cell scope. Route every getOrgPg() to the current
// peer's throwaway database, and refuse any call made outside a peer's scope instead of
// falling back to the live Postgres target. The R-8 cases pass their sql explicitly.
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { currentCellSql } = await import('../../shared-pot-loop/cell-scope');
  return {
    ...actual,
    getOrgPg: () => {
      const cellSql = currentCellSql();
      if (!cellSql) throw new Error('getOrgPg outside a harness peer scope: boot and drive peers through the harness');
      return { sql: cellSql };
    },
  };
});

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

afterEach(harnessAfterEach);

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

// ── Multi-peer cases (P-002) ────────────────────────────────────────────────────────────

/** The one acceptance run every multi-peer case below belongs to. */
const RUN: RunLedger = { id: `v1core-accept-${Date.now()}`, receipts: [] };
const MP_TIMEOUT_MS = 180_000;
const hive = (names: string[]) => createMultiPeerHarness(names, { run: RUN });
const keysOf = (rows: CanonicalDump['settings']) => rows.map((r) => r.key);

/** Drive the writers and the receiver until the receiver's delivery seam holds `atLeast` ops. */
async function waitForHeld(h: MultiPeerHarness, receiver: string, writers: string[], atLeast: number): Promise<void> {
  const ok = await pollUntil(
    async () => {
      for (const w of writers) await h.live(w).drain();
      await h.live(receiver).handle.mergeNow();
      return h.peer(receiver).held.length >= atLeast || undefined;
    },
    { timeoutMs: 60_000, intervalMs: 50 },
  );
  expect(ok, `${receiver} never held ${atLeast} op(s) from ${writers.join(',')}`).toBe(true);
}

describe("R-1: a joiner receives the hive's existing rows", () => {
  it(
    "R-1: after B joins A's hive, B's rows equal A's multi-key fixture, including rows A changed",
    async () => {
      const h = await hive(['a']);
      await h.writeSetting('a', 'fixture-alpha', 'first');
      await h.writeSetting('a', 'fixture-beta', { n: 2 });
      await h.writeSetting('a', 'fixture-gamma', [1, 2, 3]);
      await h.writeSetting('a', 'fixture-alpha', 'changed-after-first-write');
      await h.settle();
      const fixture = (await h.dump('a')).settings;
      // The fixture is non-empty, multi-key, and carries a row changed after its first write.
      expect(fixture.length).toBeGreaterThanOrEqual(3);
      expect(fixture).toContainEqual({ key: 'fixture-alpha', value: 'changed-after-first-write' });

      await h.addPeer('b');
      await h.settle(); // stands in for join-complete until P-004
      expect((await h.dump('b')).settings).toEqual(fixture);
    },
    MP_TIMEOUT_MS,
  );
});

describe('R-3: a peer offline during writes catches up to the final row set', () => {
  it(
    "R-3: c, offline during an insert, a change and a delete, ends holding exactly the writers' final rows",
    async () => {
      const h = await hive(['a', 'b', 'c']);
      await h.writeSetting('a', 'row-alpha', 'a1');
      await h.writeSetting('a', 'row-beta', 'a2');
      await h.writeSetting('b', 'row-gamma', 'b1');
      await h.settle();
      expect(keysOf((await h.dump('c')).settings)).toEqual(['row-alpha', 'row-beta', 'row-gamma']);

      await h.stop('c');
      // The missed set: an insert, a change, a delete, and a change stamped by a skewed clock.
      await h.writeSetting('a', 'row-delta', 'inserted-while-c-offline');
      await h.writeSetting('b', 'row-alpha', 'changed-while-c-offline');
      await h.deleteSetting('a', 'row-beta');
      await h.skewClock('a', 120_000);
      await h.writeSetting('a', 'row-gamma', 'changed-by-skewed-clock');
      await h.settle();
      const final = (await h.dump('a')).settings;
      expect((await h.dump('b')).settings).toEqual(final);
      const offline = (await h.dump('c')).settings;
      expect(keysOf(final)).toContain('row-delta');
      expect(keysOf(offline)).not.toContain('row-delta');
      expect(keysOf(offline)).toContain('row-beta');
      expect(keysOf(final)).not.toContain('row-beta');
      expect(offline).toContainEqual({ key: 'row-alpha', value: 'a1' });
      expect(final).toContainEqual({ key: 'row-alpha', value: 'changed-while-c-offline' });

      // c comes back behind a partition with hostile delivery, then the partition lifts.
      h.partition(['c'], ['a', 'b']);
      h.setDeliveryFaults('c', { hold: true, reorder: true, duplicate: true });
      await h.start('c');
      await h.live('c').handle.mergeNow();
      const duringPartition = (await h.dump('c')).settings;
      expect(
        duringPartition,
        `rows reached c through the partition: ${JSON.stringify(duringPartition)}; arrivals ${JSON.stringify(
          h.arrivals.filter((x) => x.receiver === 'c' && x.receiverIncarnation === 2),
        )}; receipts ${JSON.stringify(h.receipts.filter((r) => r.kind === 'partition'))}`,
      ).toEqual(offline);
      h.heal();
      const healed = h.receiptsOf('heal').at(-1)!;
      const undelivered = healed.detail.undeliveredAtHeal as Array<{ receiver: string; missing: number }>;
      expect(undelivered.some((u) => u.receiver === 'c' && u.missing > 0)).toBe(true);
      await waitForHeld(h, 'c', ['a', 'b'], 2);
      await h.flush('c');
      h.setDeliveryFaults('c', { hold: false, reorder: false, duplicate: false });
      await h.settle();

      expect(
        (await h.dump('c')).settings,
        `c diverged after catch-up; reorder receipts on c ${JSON.stringify(
          h.receipts.filter((r) => r.kind === 'reorder' && r.peer === 'c').map((r) => r.detail),
        )}; c incarnation-2 arrivals ${JSON.stringify(
          h.arrivals.filter((x) => x.receiver === 'c' && x.receiverIncarnation === 2).map((x) => `${x.from}:${x.op}`),
        )}`,
      ).toEqual(final);
      expect((await h.dump('a')).settings).toEqual(final);
      // The missed ops reached the restarted c's apply seam; the rows were not copied in.
      const incarnation = h.peer('c').incarnation;
      expect(incarnation).toBe(2);
      const arrived = h.arrivals.filter((x) => x.receiver === 'c' && x.receiverIncarnation === incarnation);
      for (const key of ['row-delta', 'row-alpha', 'row-beta', 'row-gamma']) {
        expect(
          arrived.some((x) => x.op.includes(key)),
          `no op for ${key} reached c after it came back`,
        ).toBe(true);
      }
    },
    MP_TIMEOUT_MS,
  );
});

describe('R-4: a restarted peer keeps its identity and writes without re-joining', () => {
  it(
    'R-4: a fresh instance from the same storage presents the same member id and key and its write is accepted',
    async () => {
      const h = await hive(['a', 'b']);
      await h.settle();
      const b = h.peer('b');
      const before = h.live('b');
      const ownLogKey = before.handle.ownLog.keyHex;
      const checksOfB = () => h.admissionChecks.filter((c) => c.verifier === 'a' && c.userId === b.userId);
      const presentedBefore = checksOfB();
      expect(presentedBefore.length, 'a never checked b at first boot').toBeGreaterThan(0);
      const membersBefore = (await h.dump('a')).memberUserIds;

      const restartedAt = Date.now();
      await h.restart('b');
      const after = h.live('b');
      // A fresh instance, not the original in-memory one, over the same storage directory.
      expect(after).not.toBe(before);
      expect(after.handle).not.toBe(before.handle);
      expect(b.incarnation).toBe(2);
      expect(after.root).toBe(before.root);
      expect(after.handle.ownLog.keyHex).toBe(ownLogKey);

      // What the fresh instance presents to a: the same member id and the same device key.
      // A known member's re-announce need not trigger a fresh binding check, so when none
      // comes on its own, a's own re-verify pass checks the identity it now holds for b.
      const recheckedNaturally = await pollUntil(
        async () => {
          await h.live('b').drain();
          await h.live('a').handle.mergeNow();
          return checksOfB().some((c) => c.at >= restartedAt) || undefined;
        },
        { timeoutMs: 20_000, intervalMs: 100 },
      );
      if (!recheckedNaturally) await h.live('a').handle.reverifyAdmitted();
      expect(checksOfB().some((c) => c.at >= restartedAt), 'a never checked the restarted b').toBe(true);
      const presentedAfter = checksOfB().filter((c) => c.at >= restartedAt);
      for (const c of [...presentedBefore, ...presentedAfter]) {
        expect(c.devicePubkey).toBe(b.identity.devicePubkey);
        expect(c.member).toBe('b');
      }
      expect(presentedAfter.some((c) => c.verdict === 'verified')).toBe(true);

      // A hive write the hive accepts, from the same own log, with no join in between.
      await h.writeSetting('b', 'written-after-restart', 'accepted');
      await h.settle();
      expect((await h.dump('a')).settings).toContainEqual({ key: 'written-after-restart', value: 'accepted' });
      expect(
        h.arrivals.some(
          (x) =>
            x.receiver === 'a' &&
            x.from === 'b' &&
            x.sourceLogKeyHex === ownLogKey &&
            x.writerPubkey !== null &&
            x.op.includes('written-after-restart'),
        ),
      ).toBe(true);
      expect([...h.peers.keys()]).toEqual(['a', 'b']);
      expect((await h.dump('a')).memberUserIds).toEqual(membersBefore);
    },
    MP_TIMEOUT_MS,
  );
});

describe('R-5: a revoked device never reads rows committed after the revocation', () => {
  it(
    'R-5: revoked mid-sync, then reconnecting for catch-up, b never holds a row committed after the frontier',
    async () => {
      const h = await hive(['a', 'b', 'c']);
      await h.settle();
      h.setDeliveryFaults('b', { hold: true });
      await h.writeSetting('a', 'before-frontier', 1);
      await waitForHeld(h, 'b', ['a'], 1);
      const frontier = await h.revokeDuringSync('b');
      expect(frontier.pendingAtRevocation).toBeGreaterThan(0);
      expect(Object.keys(frontier.ownLogLengths).sort()).toEqual(['a', 'c']);

      await h.writeSetting('a', 'after-frontier', 'must-not-reach-b');
      // The revoked device actively reconnects: a fresh instance rejoins the topic, meets the
      // non-revoked peers again and asks for catch-up, with nothing held back at its seam.
      h.setDeliveryFaults('b', { hold: false });
      const reconnectAt = Date.now();
      await h.restart('b');
      const reconnected = await pollUntil(
        async () => {
          await h.live('b').handle.mergeNow();
          return (
            h.admissionChecks.some(
              (c) => c.verifier === 'b' && c.verifierIncarnation === 2 && c.member !== 'b' && c.at >= reconnectAt,
            ) || undefined
          );
        },
        { timeoutMs: 60_000, intervalMs: 100 },
      );
      expect(reconnected, 'the restarted b never reached a non-revoked peer').toBe(true);
      await h.settle();
      for (let i = 0; i < 5; i++) await h.live('b').handle.mergeNow();

      expect((await h.dump('c')).settings).toContainEqual({ key: 'after-frontier', value: 'must-not-reach-b' });
      const aKey = h.live('a').handle.ownLog.keyHex;
      // Checked first so a leak names how it happened: which incarnation of b received the
      // post-frontier op, and when, relative to the revocation and the reconnect.
      const leaked = h.arrivals.filter((x) => x.receiver === 'b' && x.op.includes('after-frontier'));
      expect(
        leaked,
        `post-frontier op reached b (frontier at ${frontier.at}, reconnect at ${reconnectAt}, a log length at frontier ${
          frontier.ownLogLengths.a
        }, b holds ${h.live('b').handle.admitted.get(aKey)?.length ?? 0})`,
      ).toEqual([]);
      expect(keysOf((await h.dump('b')).settings)).not.toContain('after-frontier');
      expect(h.live('b').handle.admitted.get(aKey)?.length ?? 0).toBeLessThanOrEqual(frontier.ownLogLengths.a!);
    },
    MP_TIMEOUT_MS,
  );
});

// Runs LAST: it reads the receipts every multi-peer case above left under RUN.id, so it
// is only meaningful when the whole file runs (vitest runs a file's tests in order).
describe('SPEC-P002-FAULT-SET-EXERCISED: every v1 fault kind has a causal receipt under this run', () => {
  it('the observed fault kinds equal the declared v1 fault set, and each kind has a causal receipt', () => {
    const DECLARED: FaultKind[] = ['clock-skew', 'duplicate', 'partition', 'reorder', 'restart', 'revoke-during-sync'];
    // `delay` is the hold step reorder needs and `heal` lifts a partition; neither is a v1 fault kind.
    const SUPPORT: FaultKind[] = ['delay', 'heal'];
    const mine = RUN.receipts.filter((r) => r.runId === RUN.id);
    expect(mine.length).toBe(RUN.receipts.length);
    const observed = [...new Set(mine.map((r) => r.kind).filter((k) => !SUPPORT.includes(k)))].sort();
    expect(observed).toEqual(DECLARED);
    const of = (k: FaultKind) => mine.filter((r) => r.kind === k);
    const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

    // partition: it held back a delivery that was still missing when it lifted.
    expect(of('partition').length).toBeGreaterThan(0);
    expect(
      of('heal').some((r) =>
        ((r.detail.undeliveredAtHeal as Array<{ missing: number }> | undefined) ?? []).some((u) => u.missing > 0),
      ),
    ).toBe(true);
    // reorder: a held batch of two or more ops was delivered in inverted order.
    expect(
      of('reorder').some((r) => {
        const arrival = r.detail.arrivalOrder as string[];
        const delivery = r.detail.deliveryOrder as string[];
        return arrival.length >= 2 && same(delivery, [...arrival].reverse()) && !same(delivery, arrival);
      }),
    ).toBe(true);
    // duplicate: one envelope went through the receiver's projection twice.
    expect(
      of('duplicate').some(
        (r) => typeof r.detail.op === 'string' && 'firstApplied' in r.detail && 'secondApplied' in r.detail,
      ),
    ).toBe(true);
    // clock skew: a receiver got an op whose conflict timestamp the skew pushed ahead of now.
    expect(
      of('clock-skew').some((r) => typeof r.detail.from === 'string' && (r.detail.aheadMs as number) > 0),
    ).toBe(true);
    // revoke: committed while the revoked device still had sync work pending.
    expect(of('revoke-during-sync').some((r) => (r.detail.pendingAtRevocation as number) > 0)).toBe(true);
    // restart: a fresh peer built from the same persisted storage (same own-log key).
    expect(
      of('restart').some(
        (r) =>
          (r.detail.incarnation as number) >= 2 &&
          typeof r.detail.ownLogKeyBefore === 'string' &&
          r.detail.ownLogKeyAfter === r.detail.ownLogKeyBefore &&
          typeof r.detail.root === 'string',
      ),
    ).toBe(true);
  });
});
