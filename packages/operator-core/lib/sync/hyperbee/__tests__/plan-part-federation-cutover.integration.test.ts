/**
 * Per-part plan-federation CUTOVER acceptance — flag-ON mutual exclusion on real PG
 * (plan-federation-regrain-2026-06-13 P-009 / D-004; verifies the owner-authorised
 * P-008 cutover before the flag flip).
 *
 * THE PROPERTY UNDER TEST: with papercusp-plan-part-federation ON, the whole-blob
 * `plans-by-slug` path must NOT clobber a per-part merge. The whole-blob projection
 * (projections/harness-plans.ts) drops to BOOTSTRAP-ONLY (INSERT … ON CONFLICT DO
 * NOTHING) and the per-part recompose (projections/harness-plan-parts.ts) becomes
 * the SOLE writer of harness_plans content + scalars. This proves it end-to-end on
 * real Postgres with the REAL projections + the REAL triggers (mig 125 plans
 * capture, mig 214 local-stamp, mig 270/271 parts table + capture, mig 102 outbox):
 *
 *   1. flag ON: a whole-blob op for a NEW plan still BOOTSTRAPS it (INSERT).
 *   2. flag ON: a stale whole-blob op for an EXISTING plan is IGNORED (DO NOTHING) —
 *      no clobber.
 *   3. flag ON (the headline): concurrent edits to DIFFERENT items both survive —
 *      the per-part recompose merges them; the stale whole-blob ops don't clobber.
 *   4. flag ON: the recompose re-derives the scalar columns (a status change in the
 *      frontmatter part federates).
 *   5. flag OFF (control): the whole-blob op UPDATES (clobbers) — proving the gate
 *      is load-bearing and the flag-OFF path is byte-unchanged.
 *   6. TWO-INSTANCE convergence (separate PG dbs): a local part edit on A captures
 *      via the REAL mig-271 trigger → outbox; applied on B's real projection it
 *      merges; cross-applied both peers converge byte-identically with BOTH edits.
 *
 * Owns its schema (mig 102 outbox/capture-fn + column-faithful harness_plans stub +
 * mig 125 plans capture + mig 214 stamp + mig 270/271 parts); does not touch the dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { buildHarnessPlansProjection, type HarnessPlanRow } from '../projections/harness-plans';
import { buildHarnessPlanPartsProjection, type PlanPartWireRow } from '../projections/harness-plan-parts';
import { PgPlanPartsStore } from '../../../plan-parts/store';
import { capturePlanParts } from '../../../plan-parts/federation';
import { hashPlanContent, splitPlanIntoParts } from '@papercusp/plan-parser';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_cutover';
const H = 'papercup';
const SLUG = 'cutover-plan';

function planMarkdown(p1: string, p2: string, status = 'draft'): string {
  return [
    '---',
    'title: Cutover Test',
    `slug: ${SLUG}`,
    `status: ${status}`,
    'created: 2026-06-13',
    'updated: 2026-06-13',
    'owner: o@example.com',
    '---',
    '',
    '# Cutover Test',
    '',
    '## Phase 1 — work',
    '',
    `- **P-001** \`todo\` ${p1}`,
    `- **P-002** \`todo\` ${p2}`,
    '',
  ].join('\n');
}

function planRow(content: string, status = 'draft'): HarnessPlanRow {
  return {
    harness_slug: H,
    plan_slug: SLUG,
    content,
    content_hash: hashPlanContent(content),
    title: 'Cutover Test',
    status,
    created: '2026-06-13',
    updated: '2026-06-13',
    owner: 'o@example.com',
    supersedes: [],
    superseded_by: null,
    archived: false,
    is_legacy: false,
  };
}

/** The full plan schema + every trigger this cutover rides, applied to one db. */
async function setupSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
    END $r$;
  `);
  // Mig 102 (archive) attaches generic capture triggers to the consolidated
  // tables, so column-faithful stubs must exist first (ei117 pattern).
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      feature_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.harness_issues_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL, author_pubkey TEXT,
      origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id)
    );
  `);
  await sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));

  // Column-faithful harness_plans stub (ei117) + the parts table from mig 270.
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id  TEXT NOT NULL,
      harness_slug  TEXT NOT NULL,
      plan_slug     TEXT NOT NULL,
      title         TEXT,
      status        TEXT,
      created       TEXT,
      updated       TEXT,
      owner         TEXT,
      supersedes    TEXT[] NOT NULL DEFAULT '{}',
      superseded_by TEXT,
      content       TEXT NOT NULL DEFAULT '',
      content_hash  TEXT NOT NULL DEFAULT '',
      version       BIGINT NOT NULL DEFAULT 0,
      archived      BOOLEAN NOT NULL DEFAULT false,
      is_legacy     BOOLEAN NOT NULL DEFAULT false,
      author_pubkey TEXT,
      origin        TEXT NOT NULL DEFAULT 'local',
      fed_ts        BIGINT,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
  `);
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '125-harness-plans-federation.sql'), 'utf8')));
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '270-harness-plan-parts.sql'), 'utf8')));
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '271-harness-plan-parts-capture.sql'), 'utf8')));

  // Mig 214 attaches its stamp trigger to all 11 CDC tables (strict — no silent
  // skip on a typo'd name), so cheap stubs stand in for the ones not written here.
  await sql.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (id INT, origin TEXT, fed_ts BIGINT);
    CREATE TABLE harness_shared.coord_conversations (id INT, origin TEXT, fed_ts BIGINT);
    CREATE TABLE harness_shared.coord_threads (id INT, origin TEXT, fed_ts BIGINT);
    CREATE TABLE harness_shared.coord_thread_posts (id INT, origin TEXT, fed_ts BIGINT);
    CREATE TABLE harness_shared.plan_item_assignments (id INT, origin TEXT, fed_ts BIGINT);
    CREATE TABLE harness_shared.hive_settings (id INT, origin TEXT, fed_ts BIGINT);
    CREATE TABLE harness_shared.hive_members (id INT, origin TEXT, fed_ts BIGINT);
    CREATE TABLE harness_shared.engineer_issues (id INT, origin TEXT, fed_ts BIGINT);
  `);
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '214-federated-fed-ts-local-stamp.sql'), 'utf8')));
}

/** A peer: its db + the two real projections (flag-configurable) + its part store. */
function peer(sql: postgres.Sql, flagOn: boolean) {
  const isFlagOn = async () => flagOn;
  const store = new PgPlanPartsStore(sql, WS, H);
  const plans = buildHarnessPlansProjection({ workspaceId: WS, harnessSlug: H, sql, isFlagOn });
  const parts = buildHarnessPlanPartsProjection({ workspaceId: WS, harnessSlug: H, sql, store, isFlagOn });
  const getPlan = async () => {
    const [r] = await sql<Array<{ content: string; status: string | null; origin: string; version: number }>>`
      SELECT content, status, origin, version::int AS version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = ${SLUG}`;
    return r;
  };
  const outboxCount = async () => {
    const [r] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    return r!.n;
  };
  // Apply a whole-blob op as a remote peer would (origin remote, given wire ts).
  const recvWholeBlob = (content: string, ts: number, status = 'draft') =>
    plans.writeToPg(planRow(content, status), { authorPubkey: 'REMOTE', origin: 'remote', ts });
  // Apply a single part op as a remote peer would.
  const recvPart = (row: PlanPartWireRow, ts: number) =>
    parts.writeToPg(row, { authorPubkey: 'REMOTE', origin: 'remote', ts });
  // Find a seeded part's wire row by item id (key/body derived from the store).
  const partRowFor = async (planSlug: string, idToken: string): Promise<PlanPartWireRow> => {
    const all = await store.getParts(planSlug);
    for (const [key, p] of all) {
      if (p.kind === 'item' && (key.includes(idToken) || p.text.includes(idToken))) {
        return { harness_slug: H, plan_slug: planSlug, part_key: key, kind: p.kind, body: p.text, ordinal: p.order, tombstone: false };
      }
    }
    throw new Error(`no item part for ${idToken}`);
  };
  return { sql, store, plans, parts, getPlan, outboxCount, recvWholeBlob, recvPart, partRowFor };
}

describe('plan-part federation cutover (real PG: flag-ON mutual exclusion, no clobber)', () => {
  let db: FreshPgDb;
  let p: ReturnType<typeof peer>;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_cutover');
    await setupSchema(db.sql);
    p = peer(db.sql, true); // flag ON
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('1. flag ON: a whole-blob op for a NEW plan BOOTSTRAPS it (INSERT)', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100);
    expect((await p.getPlan())!.content).toBe(c0);
  });

  it('2. flag ON: a stale whole-blob op for an EXISTING plan is IGNORED (DO NOTHING, no clobber)', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // bootstrap
    await p.recvWholeBlob(planMarkdown('CLOBBER-1', 'CLOBBER-2'), 200); // stale whole-doc
    expect((await p.getPlan())!.content).toBe(c0); // unchanged — gate held
  });

  it('3. flag ON (HEADLINE): concurrent different-item edits both survive; whole-blob does not clobber', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // bootstrap content
    // Seed parts from C0 (the backfill); clear the capture echo it produces.
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;

    const p1 = await p.partRowFor(SLUG, 'P-001');
    const p2 = await p.partRowFor(SLUG, 'P-002');
    // Peer X edits P-001, peer Y edits P-002 — each arrives as a (stale) whole-blob
    // op AND its part op, newer than the bootstrap. Apply interleaved.
    await p.recvWholeBlob(planMarkdown('one-X', 'two'), 201); // X's stale full doc
    await p.recvPart({ ...p1, body: '- **P-001** `todo` one-X' }, 201);
    await p.recvWholeBlob(planMarkdown('one', 'two-Y'), 202); // Y's stale full doc
    await p.recvPart({ ...p2, body: '- **P-002** `todo` two-Y' }, 202);

    const content = (await p.getPlan())!.content;
    expect(content).toContain('one-X'); // X's edit survived
    expect(content).toContain('two-Y'); // Y's edit survived — MERGE, not clobber
    expect(content).not.toContain('`todo` one\n'); // original P-001 line gone
    expect(content).not.toContain('`todo` two\n'); // original P-002 line gone
  });

  it('4. flag ON: the recompose re-derives scalar columns (a status change federates)', async () => {
    const c0 = planMarkdown('one', 'two', 'draft');
    await p.recvWholeBlob(c0, 100);
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    expect((await p.getPlan())!.status).toBe('draft');

    // A remote edit flips the frontmatter part's status to active.
    const all = await p.store.getParts(SLUG);
    let fmKey = '';
    for (const [key, part] of all) if (part.kind === 'frontmatter') fmKey = key;
    expect(fmKey).not.toBe('');
    const fmPart = all.get(fmKey)!;
    await p.recvPart(
      { harness_slug: H, plan_slug: SLUG, part_key: fmKey, kind: 'frontmatter', body: fmPart.text.replace('status: draft', 'status: active'), ordinal: fmPart.order, tombstone: false },
      300,
    );
    expect((await p.getPlan())!.status).toBe('active'); // scalar re-derived from frontmatter part
  });

  it('7. flag ON RECEIVE baseline (P-010): a parts-empty peer (content via whole-blob) merges a lone incoming part — not a broken one-part doc', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // content present via whole-blob bootstrap…
    expect((await p.store.getParts(SLUG)).size).toBe(0); // …but harness_plan_parts is EMPTY (no backfill)

    // A lone remote part op for P-001 arrives. applyPart must self-baseline from
    // the local harness_plans.content FIRST, then merge — else recompose would
    // produce join({1 part}) and erase P-002.
    const edited = splitPlanIntoParts(planMarkdown('one-REMOTE', 'two')).find((pt) => pt.key === 'item:P-001')!;
    await p.recvPart({ harness_slug: H, plan_slug: SLUG, part_key: edited.key, kind: edited.kind, body: edited.text, ordinal: edited.order, tombstone: false }, 700);

    const content = (await p.getPlan())!.content;
    expect(content).toContain('one-REMOTE'); // the incoming edit applied
    expect(content).toContain('`todo` two'); // P-002 survived (baseline seeded it)
    expect(content).toContain('## Phase 1 — work'); // structure intact, not a 1-part doc
  });
});

describe('plan-part federation cutover — flag-OFF control (whole-blob path byte-unchanged)', () => {
  let db: FreshPgDb;
  let p: ReturnType<typeof peer>;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_cutover_off');
    await setupSchema(db.sql);
    p = peer(db.sql, false); // flag OFF
  }, 60_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('5. flag OFF: a newer whole-blob op UPDATES content (clobbers) — gate is load-bearing', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // full upsert (insert)
    await p.recvWholeBlob(planMarkdown('one-NEW', 'two-NEW'), 200); // newer → applies
    expect((await p.getPlan())!.content).toBe(planMarkdown('one-NEW', 'two-NEW')); // whole-doc LWW (the legacy behavior)
  });
});

describe('plan-part federation cutover — TWO-INSTANCE convergence (separate PG dbs, flag ON)', () => {
  let dbA: FreshPgDb;
  let dbB: FreshPgDb;
  let A: ReturnType<typeof peer>;
  let B: ReturnType<typeof peer>;

  beforeAll(async () => {
    dbA = await createFreshPgDb('plan_part_conv_a');
    dbB = await createFreshPgDb('plan_part_conv_b');
    await setupSchema(dbA.sql);
    await setupSchema(dbB.sql);
    A = peer(dbA.sql, true);
    B = peer(dbB.sql, true);
  }, 90_000);
  afterAll(async () => { await dbA?.cleanup(); await dbB?.cleanup(); });

  it('6. a local part edit on A captures via the real trigger; cross-applied, A and B converge byte-identically with BOTH edits', async () => {
    const c0 = planMarkdown('one', 'two');
    // Both peers start at C0 (bootstrap content + seed parts).
    for (const x of [A, B]) {
      await x.recvWholeBlob(c0, 100);
      await capturePlanParts(x.store, SLUG, c0, 100, 'seed');
      await x.sql`DELETE FROM harness_shared.substrate_outbox`;
    }

    // A LOCALLY edits P-001 (origin local) → the REAL mig-271 capture trigger fires.
    const aP1 = await A.partRowFor(SLUG, 'P-001');
    await A.store.upsertPart(SLUG, { key: aP1.part_key, kind: 'item', text: '- **P-001** `todo` one-A', order: aP1.ordinal, fedTs: 201, author: 'A' }, 'local');
    expect(await A.outboxCount()).toBeGreaterThan(0); // capture fired on the local part write

    // B LOCALLY edits P-002.
    const bP2 = await B.partRowFor(SLUG, 'P-002');
    await B.store.upsertPart(SLUG, { key: bP2.part_key, kind: 'item', text: '- **P-002** `todo` two-B', order: bP2.ordinal, fedTs: 202, author: 'B' }, 'local');

    // Cross-apply each peer's edited part to the other (what the swarm carries).
    await B.recvPart({ harness_slug: H, plan_slug: SLUG, part_key: aP1.part_key, kind: 'item', body: '- **P-001** `todo` one-A', ordinal: aP1.ordinal, tombstone: false }, 201);
    await A.recvPart({ harness_slug: H, plan_slug: SLUG, part_key: bP2.part_key, kind: 'item', body: '- **P-002** `todo` two-B', ordinal: bP2.ordinal, tombstone: false }, 202);
    // Each peer also recomposes its own local edit into harness_plans (the local
    // write path does this; here drive it via a self-apply of the local part).
    await A.recvPart({ harness_slug: H, plan_slug: SLUG, part_key: aP1.part_key, kind: 'item', body: '- **P-001** `todo` one-A', ordinal: aP1.ordinal, tombstone: false }, 201);
    await B.recvPart({ harness_slug: H, plan_slug: SLUG, part_key: bP2.part_key, kind: 'item', body: '- **P-002** `todo` two-B', ordinal: bP2.ordinal, tombstone: false }, 202);

    const ca = (await A.getPlan())!.content;
    const cb = (await B.getPlan())!.content;
    expect(ca).toContain('one-A');
    expect(ca).toContain('two-B');
    expect(cb).toContain('one-A');
    expect(cb).toContain('two-B');
    expect(ca).toBe(cb); // byte-identical convergence across two separate databases
  });
});
