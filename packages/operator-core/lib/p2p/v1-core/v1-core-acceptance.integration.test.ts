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
 * R-2 and R-6 (P-003, fail-closed merge rules) run on the same harness. R-2 checks the
 * conflict winner against the rule read from the merge-rule registry and the clocks the
 * envelopes carried, never against what the projection reports. R-6 withdraws or replaces
 * the declared rule of two tables the rig really captures (see `ruleOverride`), so the
 * capture seam, the drain and the second peer are all the production code paths.
 *
 * A later plan item extends this file with R-9 (P-004).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { HIVE_SLUG, pollUntil, WORKSPACE_ID } from '../../sync/hyperbee/__tests__/_hive-substrate-rig';
import { assertReplicationRule, replicationRuleFor } from '../../sync/hyperbee/merge-rules';
import { DEFAULT_JOIN_STALL_AFTER_MS, JOIN_TIMEOUTS_MS, longestJoinTimeoutMs } from '../../sync/hyperbee/join-progress';
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

// R-6 fixtures: a table tag listed here replicates as if it were undeclared (no census
// entry, no declared rule) or as if it declared the given rule. Every other tag, and every
// tag outside the R-6 case, resolves through the real registry unchanged.
const ruleOverride = vi.hoisted(() => new Map<string, 'undeclared' | { declared: unknown }>());
vi.mock('../../sync/hyperbee/merge-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/hyperbee/merge-rules')>();
  const resolve = (table: string, declared: unknown): [string, unknown] => {
    const o = ruleOverride.get(table);
    if (o === undefined) return [table, declared];
    if (o === 'undeclared') return [`${table}#r6-undeclared`, undefined];
    return [table, o.declared];
  };
  return {
    ...actual,
    replicationRuleFor: (table: string, declared?: unknown) => actual.replicationRuleFor(...resolve(table, declared)),
    assertReplicationRule: (table: string, declared?: unknown) =>
      actual.assertReplicationRule(...resolve(table, declared)),
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

/** Real head snapshot followed by individually held tail applies. The virtual clock
 * belongs only to join progress, so advancing it cannot expire a wire/PG operation. */
async function slowBackfillJoin() {
  let now = 0;
  let open = false;
  const waiting: Array<() => void> = [];
  const h = await createMultiPeerHarness(['a'], {
    run: RUN,
    joinProgressNow: () => now,
    mergePollMs: 10,
    beforeApply: async (peer, op) => {
      if (peer === 'b' && op.hbKey?.includes('r9-backfill-') && !open) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
  });
  const releaseAll = () => {
    open = true;
    for (const release of waiting.splice(0)) release();
  };
  try {
    for (let i = 0; i < 16; i += 1) await h.writeSetting('a', 'r9-current', i);
    await h.writeSetting('a', 'r9-stable', 'readable from the head');
    await h.settle();
    const headRows = (await h.dump('a')).settings;
    const snapshot = await h.live('a').handle.produceHeadSnapshotNow();
    expect(snapshot.appended).toBe(true);
    expect(snapshot.rowCount).toBe(headRows.length);
    expect(snapshot.rowCount).toBeLessThan(snapshot.coversUpTo);
    const tailCount = 8;
    for (let i = 0; i < tailCount; i += 1) await h.writeSetting('a', `r9-backfill-${i}`, i);
    await h.live('a').drain();
    await h.addPeer('b');
    const held = await pollUntil(async () => waiting.length > 0 || undefined, { timeoutMs: 60_000, intervalMs: 10 });
    if (!held) {
      throw new Error(`R-9 tail never reached its apply throttle: ${JSON.stringify({
        progress: await h.live('b').handle.joinProgress(),
        pending: await h.pendingWork(), arrivals: h.arrivals, admissionChecks: h.admissionChecks,
      })}`);
    }
    return {
      h, headRows, tailCount, waiting, releaseAll,
      advance: (ms: number) => { now += ms; return now; },
    };
  } catch (error) {
    releaseAll();
    throw error;
  }
}

describe('R-9: progress-based join from a small head snapshot', () => {
  const expectedTimerWarning = /^\[scheduled-registry\] hyperbee-merge-poll (?:tick still running after \d+ms \(\d+ fire\(s\) skipped by the re-entrancy guard, interval 10ms\)|long tick finished after \d+ms \(\d+ fire\(s\) skipped while it ran, interval 10ms\))$/;
  let timerWarnings: string[];
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    timerWarnings = [];
    const realWarn = console.warn.bind(console);
    warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (args.length === 1 && expectedTimerWarning.test(String(args[0]))) timerWarnings.push(String(args[0]));
      else realWarn(...args);
    });
  });
  afterEach(async () => {
    try {
      // Keep the exact warning assertion active through the held pass's teardown.
      await harnessAfterEach();
      expect(timerWarnings.some((warning) => warning.includes('re-entrancy guard'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('R-9: head rows stay readable while every tail advance passes every join deadline without failure', async () => {
    const run = await slowBackfillJoin();
    const { h, headRows, tailCount, waiting } = run;
    try {
      const handle = h.live('b').handle;
      let progress = (await handle.joinProgress())!;
      const readableHead = (await h.dump('b')).settings;
      const headDiagnostic = JSON.stringify({ progress, readableHead, expectedHead: headRows, pending: await h.pendingWork() });
      expect(readableHead, headDiagnostic).toEqual(headRows);
      expect(progress.joinState, headDiagnostic).toBe('usable');
      expect(progress.mergedOps).toBeLessThan(progress.targetFrontier);
      expect(await pollUntil(async () => timerWarnings.length > 0 || undefined, { timeoutMs: 60_000, intervalMs: 10 })).toBe(true);
      // The old overwritten values were summarized, rather than replayed before usability.
      expect(h.arrivals.filter((arrival) => arrival.receiver === 'b' && arrival.op.includes('r9-current'))).toHaveLength(1);
      for (let i = 0; i < tailCount; i += 1) {
        expect(await pollUntil(async () => waiting.length > 0 || undefined, { timeoutMs: 60_000, intervalMs: 10 })).toBe(true);
        const before = progress.mergedOps;
        const virtualNow = run.advance(longestJoinTimeoutMs() + 1);
        for (const deadline of Object.values(JOIN_TIMEOUTS_MS)) expect(virtualNow).toBeGreaterThan(deadline);
        waiting.shift()!();
        const advanced = await pollUntil(async () => {
          const sample = await handle.joinProgress();
          return sample && sample.mergedOps > before ? sample : undefined;
        }, { timeoutMs: 60_000, intervalMs: 10 });
        expect(advanced).toBeTruthy();
        progress = advanced!;
        expect(progress.joinState).not.toBe('failed');
        expect((await h.dump('b')).settings.filter((row) => !row.key.startsWith('r9-backfill-'))).toEqual(headRows);
      }
      expect(progress.joinState).toBe('complete');
      expect(progress.caughtUp).toBe(true);
      expect((await h.dump('b')).settings).toEqual((await h.dump('a')).settings);
    } finally {
      run.releaseAll();
    }
  }, MP_TIMEOUT_MS);

  it('R-9 control: a frozen applied frontier reports stalled, then recovers when backfill resumes', async () => {
    const run = await slowBackfillJoin();
    try {
      const handle = run.h.live('b').handle;
      const before = (await handle.joinProgress())!;
      run.advance(DEFAULT_JOIN_STALL_AFTER_MS + 1);
      expect(await handle.joinProgress()).toMatchObject({ joinState: 'failed', caughtUp: false, mergedOps: before.mergedOps });
      run.releaseAll();
      await run.h.settle();
      expect(await handle.joinProgress()).toMatchObject({ joinState: 'complete', caughtUp: true });
    } finally {
      run.releaseAll();
    }
  }, MP_TIMEOUT_MS);
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

/** An HLC string as the comparable pair the clock orders by (wall ms, then counter). */
function hlcPair(op: string): [number, number] {
  const [ms, counter] = op.slice(op.lastIndexOf('@') + 1).split(':');
  return [Number.parseInt(ms ?? '', 10), Number.parseInt(counter ?? '0', 10)];
}

describe('R-2: concurrent offline writes converge after reconnect', () => {
  it(
    'R-2: partitioned writers with a same-key conflict hold identical rows and the LWW winner after skew, reorder and duplicate',
    async () => {
      const h = await hive(['a', 'b']);
      await h.settle();
      const caseStart = h.receipts.length;
      h.partition(['a'], ['b']);
      // a's clock runs 120s ahead, so a's conflicting write carries the higher clock even
      // though b writes the same key later in wall-clock time.
      await h.skewClock('a', 120_000);
      await h.writeSetting('a', 'r2-conflict', 'from-a-clock-ahead');
      await h.writeSetting('a', 'r2-a-one', 'a1');
      await h.writeSetting('a', 'r2-a-two', 'a2');
      await h.writeSetting('b', 'r2-b-one', 'b1');
      await h.writeSetting('b', 'r2-conflict', 'from-b-later-wall-clock');
      for (const p of ['a', 'b']) {
        await h.live(p).drain();
        await h.live(p).handle.mergeNow();
      }
      expect(keysOf((await h.dump('b')).settings)).not.toContain('r2-a-one');
      expect(keysOf((await h.dump('a')).settings)).not.toContain('r2-b-one');

      h.setDeliveryFaults('b', { hold: true, reorder: true, duplicate: true });
      h.heal();
      await waitForHeld(h, 'b', ['a'], 3);
      await h.flush('b');
      h.setDeliveryFaults('b', { hold: false, reorder: false, duplicate: false });
      await h.settle();
      expect((await h.pendingWork()).total).toBe(0);

      const rowsA = (await h.dump('a')).settings;
      expect((await h.dump('b')).settings).toEqual(rowsA);
      for (const k of ['r2-a-one', 'r2-a-two', 'r2-b-one', 'r2-conflict']) expect(keysOf(rowsA)).toContain(k);

      // The declared rule, read from the registry, selects the higher clock. The two clocks
      // are the ones the conflicting envelopes carried to the other peer's apply seam.
      expect(replicationRuleFor('hive-settings-by-key')).toBe('lww');
      const conflict = (from: string) => h.arrivals.find((x) => x.from === from && x.op.includes('r2-conflict@'));
      const fromA = conflict('a');
      const fromB = conflict('b');
      expect(fromA, 'a conflicting op from a never reached b').toBeDefined();
      expect(fromB, 'a conflicting op from b never reached a').toBeDefined();
      const [aMs, aCounter] = hlcPair(fromA!.op);
      const [bMs, bCounter] = hlcPair(fromB!.op);
      expect(Number.isFinite(aMs) && Number.isFinite(bMs)).toBe(true);
      const aWins = aMs > bMs || (aMs === bMs && aCounter > bCounter);
      // The case is only discriminating when the clock winner is not the last wall-clock writer.
      expect(aWins, `a@${fromA!.op} vs b@${fromB!.op}`).toBe(true);
      expect(rowsA).toContainEqual({ key: 'r2-conflict', value: 'from-a-clock-ahead' });

      // Each configured fault left a receipt on an envelope this case sent.
      const mine = h.receipts.slice(caseStart);
      const ofCase = (op: unknown) => typeof op === 'string' && op.includes('r2-');
      const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
      expect(mine.some((r) => r.kind === 'partition')).toBe(true);
      expect(
        mine.some(
          (r) =>
            r.kind === 'heal' &&
            ((r.detail.undeliveredAtHeal as Array<{ receiver: string; missing: number }> | undefined) ?? []).some(
              (u) => u.receiver === 'b' && u.missing > 0,
            ),
        ),
      ).toBe(true);
      expect(
        mine.some((r) => {
          if (r.kind !== 'reorder' || r.peer !== 'b') return false;
          const arrival = r.detail.arrivalOrder as string[];
          const delivery = r.detail.deliveryOrder as string[];
          return arrival.length >= 2 && arrival.some(ofCase) && same(delivery, [...arrival].reverse()) && !same(delivery, arrival);
        }),
        'no reorder receipt on b for this case',
      ).toBe(true);
      expect(
        mine.some((r) => r.kind === 'duplicate' && r.peer === 'b' && ofCase(r.detail.op)),
        'no duplicate receipt on b for this case',
      ).toBe(true);
      expect(
        mine.some(
          (r) =>
            r.kind === 'clock-skew' &&
            r.peer === 'b' &&
            r.detail.from === 'a' &&
            (r.detail.aheadMs as number) > 0 &&
            ofCase(r.detail.op),
        ),
        'no clock-skew receipt on b for an op of this case',
      ).toBe(true);
    },
    MP_TIMEOUT_MS,
  );
});

describe('R-6: a table without a declared v1 merge rule is not replicated', () => {
  afterEach(() => ruleOverride.clear());

  it(
    'R-6: the simple-rule table replicates; the undeclared and the non-simple table produce no op and no row on b',
    async () => {
      // Boot first, under the real census. Registration refuses a projection whose static
      // rule is missing or non-simple (boot fails loudly, asserted just below), so a peer
      // booted under these overrides never starts. What R-6 measures is the run-time
      // case: a captured table whose rule is absent or outside the simple set when its
      // rows reach the capture, fold and apply seams.
      const h = await hive(['a', 'b']);
      await h.settle();

      // The rig's real capture triggers capture both consolidated tables. Withdraw the
      // `issues` rule (an undeclared table) and have `features-by-id` declare `max`.
      ruleOverride.set('issues', 'undeclared');
      ruleOverride.set('features-by-id', { declared: 'max' });
      expect(replicationRuleFor('hive-settings-by-key')).toBe('lww');
      expect(replicationRuleFor('issues')).toBeUndefined();
      expect(replicationRuleFor('features-by-id')).toBeUndefined();
      // The registration form refuses both declarations with their reasons.
      expect(() => assertReplicationRule('issues')).toThrow(/Missing merge rule/);
      // SPEC-P003: the non-simple declaration is rejected, not narrowed to a default.
      expect(() => assertReplicationRule('features-by-id')).toThrow(/outside the v1 simple rule set/);

      const a = h.live('a');
      const keys = ['r6-non-simple-row', 'r6-undeclared-row'];
      const ownLogBefore = a.handle.ownLog.length;
      // The drain refuses each table once, loudly, naming the reason. Spy from before the
      // writes: any drain pass that reaches the rows (ours or a background one) logs it.
      // Any other warning still reaches the real console.warn (and fails the test).
      const realWarn = console.warn.bind(console);
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        if (!String(args[0]).startsWith('[outbox-drain] skipping outbox rows')) realWarn(...args);
      });
      await a.pg`INSERT INTO harness_shared.harness_issues_consolidated (workspace_id, harness_slug, issue_id)
                 VALUES (${WORKSPACE_ID}, ${HIVE_SLUG}, 'r6-undeclared-row')`;
      await a.pg`INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id)
                 VALUES (${WORKSPACE_ID}, ${HIVE_SLUG}, 'r6-non-simple-row')`;
      const outbox = () =>
        a.pg<Array<{ table_name: string; key: string; drained: boolean }>>`
          SELECT table_name, key, drained_at IS NOT NULL AS drained FROM harness_shared.substrate_outbox
           WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${HIVE_SLUG} AND key IN ${a.pg(keys)}
           ORDER BY key`;
      // Not vacuous: both writes were captured, inside the drain's own scope.
      expect((await outbox()).map((r) => [r.table_name, r.key])).toEqual([
        ['harness_features_consolidated', 'r6-non-simple-row'],
        ['harness_issues_consolidated', 'r6-undeclared-row'],
      ]);
      await a.drain();
      await a.drain();
      // Zero operations at the capture seam: nothing appended, both rows left undrained.
      expect(a.handle.ownLog.length).toBe(ownLogBefore);
      expect((await outbox()).map((r) => r.drained)).toEqual([false, false]);
      const refusals = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith('[outbox-drain] skipping outbox rows'))
        .sort();
      warn.mockRestore();
      expect(refusals).toEqual([
        "[outbox-drain] skipping outbox rows for table 'harness_features_consolidated' (tag 'features-by-id'): " +
          'it has no merge rule in the v1 simple set, so it does not replicate (fail-closed). Rows stay undrained.',
        "[outbox-drain] skipping outbox rows for table 'harness_issues_consolidated' (tag 'issues'): " +
          'it has no merge rule in the v1 simple set, so it does not replicate (fail-closed). Rows stay undrained.',
      ]);

      // Control: the simple table, written after them, still replicates to b.
      await h.writeSetting('a', 'r6-simple', 'replicates');
      await h.settle();
      expect(a.handle.ownLog.length).toBeGreaterThan(ownLogBefore);
      expect((await h.dump('b')).settings).toContainEqual({ key: 'r6-simple', value: 'replicates' });

      // Zero rows on the second peer, and no op for either row reached b's apply seam.
      const b = h.live('b');
      const [issues] = await b.pg<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM harness_shared.harness_issues_consolidated WHERE issue_id = 'r6-undeclared-row'`;
      const [features] = await b.pg<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM harness_shared.harness_features_consolidated WHERE feature_id = 'r6-non-simple-row'`;
      expect([issues?.n, features?.n]).toEqual([0, 0]);
      expect(h.arrivals.filter((x) => keys.some((k) => x.op.includes(k)))).toEqual([]);
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
