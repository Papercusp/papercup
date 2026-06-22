/**
 * lifecycle-membership-teardown.integration.test.ts — the LIFECYCLE half of
 * test-coverage gaps G24 (dissolve) + G27 (leave-hive), against real Postgres.
 *
 * Both gaps are now CLOSED (shared-hive-public-release-2026-06-22). The federation
 * sibling (`sync/hyperbee/__tests__/hive-membership-teardown-federation.integration.
 * test.ts`) proves the SUBSTRATE can federate a membership teardown: deleting a
 * `hive_members` row enqueues a `del` (mig-189 capture) that federates and removes
 * the member on a peer. THIS test proves the lifecycle ops that SHOULD trigger that
 * teardown now DO — closing both gaps end-to-end.
 *
 * ── G27: leaveHive now drops the leaver's hive_members row (+ federates a del) ──
 * `leaveHive` (the joiner-side leave) drops the leaver's `shared_presence` rows AND
 * — its new membership-teardown leg — DELETEs the leaver's persistent `hive_members`
 * admission row. The DELETE fires the mig-189 capture trigger, enqueuing a `del` op
 * into `substrate_outbox` so the departure federates as a membership tombstone. This
 * test seeds BOTH a presence row and a hive_members row, runs the REAL `leaveHive`
 * against real PG (with the leaver's gh id resolved to the seeded member), and
 * asserts: presence GONE (existing behavior) AND hive_members GONE (the fix) AND a
 * `del` op captured for the leaver (the federation handoff).
 *
 * ── G24: hive:dissolve now tears down all of a hive's hive_members rows ──
 * `hive:dissolve` (the owner-side teardown of a LOCAL hive) gained a membership-
 * teardown leg that calls `removeAllHiveMembers(workspaceId, hiveHomeSlug)` BEFORE
 * deregister. Each per-row DELETE fires the mig-189 capture trigger → a federated
 * `del` tombstone. We exercise the exact fn dissolve invokes (the full tool needs
 * fleet/wake/registry machinery out of scope for a membership-row assertion) over a
 * multi-member hive: all rows GONE + one `del` op captured per member. A static
 * assertion also guards that dissolve.ts still wires `removeAllHiveMembers`, so a
 * future refactor that drops the call is caught.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { leaveHive, type LeaveHiveDeps } from './leave-hive';
import { upsertHiveMember, getHiveMember, removeAllHiveMembers } from '../hive-membership-store';
import type { HarnessRegistry } from '../harness-registry';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
const WS = 'ws-lifecycle-gap';
const HIVE = 'shop-hive'; // the remote_hive view slug == the Hive home slug
const MEMBER_SLUG = 'shop'; // a joined member harness whose home is the hive view
const LEAVER_UID = 42;

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.shared_presence (
    workspace_id   text DEFAULT ''::text NOT NULL,
    harness_slug   text NOT NULL,
    github_user_id bigint NOT NULL,
    machine_label  text NOT NULL,
    device_pubkey  text NOT NULL,
    intent         text, current_view text,
    last_seen_at   timestamptz DEFAULT now() NOT NULL,
    schema_version bigint DEFAULT 1 NOT NULL,
    hive_slug      text, fed_ts bigint,
    fed_hlc        text,
    PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
  )`;

function stripMeta(sqlText: string): string {
  return sqlText
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

/** Count the `del` ops captured for one hive_members key (github_user_id) — the
 *  federation handoff the mig-189 trigger enqueues on DELETE. */
async function delOpsFor(sql: Sql, githubUserId: number): Promise<number> {
  const [{ n }] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE table_name = 'hive_members' AND op = 'del' AND key = ${String(githubUserId)}`;
  return n;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('lifecycle-gap');
  await db.sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
    END $r$;`);
  // mig 102's generic capture triggers attach to these consolidated tables, so stub
  // them (column-faithful) before 102 loads; 189's hive_members trigger then needs
  // substrate_outbox (created by 102) to exist when upsertHiveMember INSERTs.
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      feature_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id));
    CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id));`);
  await db.sql.unsafe(readFileSync(join(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));
  for (const m of ['184-hives-table.sql', '185-hive-members-admission.sql', '189-hive-members-federation-cols.sql']) {
    await db.sql.unsafe(stripMeta(readFileSync(join(SQL_DIR, m), 'utf8')));
  }
  await db.sql.unsafe(PRESENCE_DDL);
  await db.sql`INSERT INTO harness_shared.hives (workspace_id, home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HIVE}, ${Buffer.from([0])}, 'kc-shop', 0)`;
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  // Also clear substrate_outbox so each test sees only its OWN captured ops (TRUNCATE
  // fires no row-level capture trigger, so this enqueues nothing).
  await db.sql.unsafe(
    'TRUNCATE harness_shared.hive_members, harness_shared.shared_presence, harness_shared.substrate_outbox CASCADE',
  );
});

/** A registry with a remote_hive VIEW + a joined MEMBER under it, for leaveHive. */
function joinerRegistry(): HarnessRegistry {
  return {
    projects: [
      { slug: HIVE, path: `/remote-hives/${HIVE}`, harness_kind: 'hive', remote_hive: true },
      { slug: MEMBER_SLUG, path: `/clones/${MEMBER_SLUG}`, hive_slug: HIVE, github_repository_id: 1 },
    ],
  } as unknown as HarnessRegistry;
}

/** leaveHive deps: real sql for presence + membership DELETEs; the rest seam-stubbed
 *  (no swarm/fs). The leaver's gh id is resolved to the seeded member so the REAL
 *  removeHiveMember (the default dropMembers) runs against the seeded admission row. */
function leaveDeps(sql: Sql): LeaveHiveDeps {
  let reg = joinerRegistry();
  return {
    sql,
    loadRegistry: async () => reg,
    mutateRegistry: (async (fn: (r: HarnessRegistry) => HarnessRegistry) => {
      reg = fn(reg);
      return undefined as never;
    }) as never,
    tombstonePresence: async () => false, // not booted in this test
    closeHandle: async () => false,
    removeRoutine: async () => false,
    // Resolve the leaver to the seeded member uid (the local box's gh identity isn't
    // the seeded user); dropMembers stays the REAL removeHiveMember.
    resolveLeaverGithubUserId: async () => LEAVER_UID,
    // dropPresence + dropMembers intentionally NOT overridden — the REAL DELETEs run.
  };
}

describe('G27 — leaveHive drops the leaver presence AND the persistent hive_members row (+ del op)', () => {
  it('deletes the leaver\'s hive_members admission row and enqueues a federated del tombstone', async () => {
    // Seed BOTH a presence row and a membership row for the leaver, scoped to the
    // member harness slug (presence is per-member-harness; membership is per-Hive-home).
    await db.sql`
      INSERT INTO harness_shared.shared_presence
        (workspace_id, harness_slug, github_user_id, machine_label, device_pubkey, hive_slug)
      VALUES (${WS}, ${MEMBER_SLUG}, ${LEAVER_UID}, 'machine-A', 'pk-leaver', ${HIVE})
    `;
    await upsertHiveMember(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: LEAVER_UID, githubUsername: 'alice', bindingStatus: 'verified' },
      db.sql,
    );

    // Preconditions: both rows exist.
    const presBefore = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.shared_presence
       WHERE workspace_id = ${WS} AND harness_slug = ${MEMBER_SLUG}`;
    expect(presBefore[0].n).toBe(1);
    expect(await getHiveMember(WS, HIVE, LEAVER_UID, db.sql)).not.toBeNull();

    // Run the REAL leaveHive.
    const res = await leaveHive({ workspaceId: WS, slug: HIVE }, leaveDeps(db.sql));
    expect(res.ok).toBe(true);
    expect(res.viewRemoved).toBe(true);

    // Presence WAS dropped for the member harness (the existing behavior).
    const presAfter = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.shared_presence
       WHERE workspace_id = ${WS} AND harness_slug = ${MEMBER_SLUG}`;
    expect(presAfter[0].n, 'leaveHive should have dropped the local presence row').toBe(0);
    expect(res.members.find((m) => m.slug === MEMBER_SLUG)?.presenceRowsDropped).toBe(1);

    // THE FIX (G27): the persistent hive_members admission row is GONE — leaveHive now
    // cleans membership, not just presence. The leaver is no longer an admitted member.
    const stillMember = await getHiveMember(WS, HIVE, LEAVER_UID, db.sql);
    expect(
      stillMember,
      'G27 fix: leaveHive should DELETE the leaver hive_members row (membership cleaned, not just presence)',
    ).toBeNull();
    expect(res.leaverGithubUserId).toBe(LEAVER_UID);
    expect(res.membershipRowsDropped).toBe(1);

    // FEDERATION: the DELETE fired the mig-189 capture trigger → a `del` op for the
    // leaver's key, so the departure federates to peers as a membership tombstone.
    expect(
      await delOpsFor(db.sql, LEAVER_UID),
      'the hive_members DELETE should enqueue exactly one federated del op for the leaver',
    ).toBe(1);
  });
});

describe('G24 — hive:dissolve tears down ALL of a hive\'s hive_members rows (+ del ops)', () => {
  it('removeAllHiveMembers (the leg dissolve invokes) deletes every member row and federates a del per member', async () => {
    const UID_A = 71;
    const UID_B = 72;
    await upsertHiveMember(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: UID_A, githubUsername: 'carol', bindingStatus: 'verified' },
      db.sql,
    );
    await upsertHiveMember(
      { workspaceId: WS, hiveHomeSlug: HIVE, githubUserId: UID_B, githubUsername: 'dave', bindingStatus: 'verified' },
      db.sql,
    );
    expect(await getHiveMember(WS, HIVE, UID_A, db.sql)).not.toBeNull();
    expect(await getHiveMember(WS, HIVE, UID_B, db.sql)).not.toBeNull();

    // The exact teardown leg dissolve.ts runs (before deregister, substrate live).
    const dropped = await removeAllHiveMembers(WS, HIVE, db.sql);
    expect(dropped, 'dissolve teardown should delete every hive_members row for the hive').toBe(2);

    // THE FIX (G24): all member rows GONE.
    expect(await getHiveMember(WS, HIVE, UID_A, db.sql)).toBeNull();
    expect(await getHiveMember(WS, HIVE, UID_B, db.sql)).toBeNull();

    // FEDERATION: one `del` op per member (the per-row mig-189 capture).
    expect(await delOpsFor(db.sql, UID_A)).toBe(1);
    expect(await delOpsFor(db.sql, UID_B)).toBe(1);
  });

  it('dissolve.ts wires the removeAllHiveMembers teardown leg (static guard)', () => {
    const dissolveSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../agent-tools/hive/dissolve.ts'),
      'utf8',
    );
    // G24 fix: dissolve now references hive_members teardown — it imports + calls
    // removeAllHiveMembers (was: zero references; G24 was an open gap). This guards
    // the wiring so a refactor that drops the call is caught by the lifecycle test.
    expect(/removeAllHiveMembers/.test(dissolveSrc), 'dissolve.ts must wire removeAllHiveMembers (G24)').toBe(true);
    expect(/hive_members/.test(dissolveSrc)).toBe(true);
  });
});
