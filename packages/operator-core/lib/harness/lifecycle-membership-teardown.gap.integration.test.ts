/**
 * lifecycle-membership-teardown.gap.integration.test.ts — the LIFECYCLE half of
 * test-coverage gaps G24 (dissolve) + G27 (leave-hive), against real Postgres.
 *
 * The federation sibling (`sync/hyperbee/__tests__/hive-membership-teardown-
 * federation.integration.test.ts`) proves the SUBSTRATE can federate a membership
 * teardown: deleting a `hive_members` row enqueues a `del` (mig-189 capture) that
 * federates and removes the member on a peer. THIS test proves the lifecycle ops
 * that SHOULD trigger that teardown do not — confirming both gaps are REAL.
 *
 * ── G27: leaveHive cleans presence but NOT membership ──
 * `leaveHive` (the joiner-side leave) drops the leaver's `shared_presence` rows
 * (and federates a presence tombstone, proven elsewhere) but has NO leg that
 * deletes the persistent `hive_members` admission row. This test seeds BOTH a
 * presence row and a hive_members row, runs the REAL `leaveHive` against real PG,
 * and asserts: presence GONE (the existing behavior) but hive_members STILL PRESENT
 * (the gap). leaveHive has no `dropMembers` seam at all.
 *
 * ── G24: dissolve has no membership-teardown leg ──
 * `hive:dissolve` (the owner-side teardown of a LOCAL hive) clears the Queen wake,
 * cancels bees, deregisters the home harness, tears down the learning loop, and
 * optionally drops the harness_<slug> schema — but never touches
 * `harness_shared.hive_members`. A `grep` of dissolve.ts shows zero references, and
 * `dropHarnessSchema` drops the per-harness schema, not the shared admission table.
 * (Asserted statically here — invoking the full tool needs fleet/wake/registry
 * machinery out of scope for a membership-row assertion.) So a dissolved hive's
 * members are neither deleted locally nor federated-away as tombstones: G24 is a
 * real feature gap.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { leaveHive, type LeaveHiveDeps } from './leave-hive';
import { upsertHiveMember, getHiveMember } from '../hive-membership-store';
import type { HarnessRegistry } from '../harness-registry';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from "./../../test/_work-items-schema";

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

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('lifecycle-gap');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
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
  await db.sql.unsafe('TRUNCATE harness_shared.hive_members, harness_shared.shared_presence CASCADE');
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

/** leaveHive deps: real sql for presence DELETE; the rest seam-stubbed (no swarm/fs). */
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
    // dropPresence is intentionally NOT overridden — the REAL inline DELETE runs.
  };
}

describe('G27 — leaveHive cleans presence but NOT the persistent hive_members row', () => {
  it("drops the leaver's shared_presence yet leaves their hive_members admission row intact (the gap)", async () => {
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

    // Presence WAS dropped for the member harness (the existing behavior G27 notes).
    const presAfter = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.shared_presence
       WHERE workspace_id = ${WS} AND harness_slug = ${MEMBER_SLUG}`;
    expect(presAfter[0].n, 'leaveHive should have dropped the local presence row').toBe(0);
    expect(res.members.find((m) => m.slug === MEMBER_SLUG)?.presenceRowsDropped).toBe(1);

    // THE GAP (G27): the persistent hive_members admission row is STILL there —
    // leaveHive never deletes it, so the leaver remains an admitted Hive member
    // locally (and no del-op tombstone federates the departure to peers).
    const stillMember = await getHiveMember(WS, HIVE, LEAVER_UID, db.sql);
    expect(
      stillMember,
      'FINDING (G27): leaveHive does NOT remove the hive_members row — membership is not cleaned, only presence',
    ).not.toBeNull();
    expect(stillMember?.githubUsername).toBe('alice');
  });
});

describe('G24 — hive:dissolve has no hive_members teardown leg (static finding)', () => {
  it('dissolve.ts references no hive_members teardown / removeHiveMember path', () => {
    const dissolveSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../agent-tools/hive/dissolve.ts'),
      'utf8',
    );
    // FINDING (G24): no membership-teardown leg exists in dissolve. It clears the
    // wake, cancels bees, deregisters the harness, tears down the learning loop, and
    // optionally drops the harness_<slug> SCHEMA — but never DELETEs hive_members
    // nor federates a membership tombstone. dropHarnessSchema drops harness_<slug>,
    // not harness_shared.hive_members.
    expect(/hive_members/.test(dissolveSrc)).toBe(false);
    expect(/removeHiveMember|deleteHiveMember/.test(dissolveSrc)).toBe(false);
  });
});
