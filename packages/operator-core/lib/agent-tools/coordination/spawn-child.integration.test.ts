/**
 * spawn-child.integration.test.ts — the promote spawn_child branch against a
 * REAL scratch Postgres (promote-spawn-child-harness-2026-05-31 P-006).
 *
 * Exercises `executeSpawnChild` with the REAL PG deps from
 * `buildDefaultSpawnChildDeps` — seed-plan write (`withPlanLock` →
 * `harness_shared.harness_plans`), VAL upsert (`harness_plan_assertions`), and
 * plan start (`op_status='started'`) — asserting the brief's green bar:
 *
 *   • child schema exists,
 *   • child seed plan started,
 *   • child features carry the seed slug,
 *   • the DISPATCHER would pick them up (the started-plan eligibility gate),
 *   • a re-run is idempotent (D-004 retry).
 *
 * Two seams are simulated (they shell out / need the live operator, out of
 * scope for a scratch-workspace test): `scaffold` (the real one runs
 * `papercusp init` + the marketplace catalog — here it creates the per-harness
 * PG schema + registers the slug, the PG-visible side of doScaffoldHarness)
 * and `importFeatures` (the real one POSTs /features/import over loopback —
 * here it upserts harness_features_consolidated the way the import route's
 * SQLite write + consolidated trigger land it). Everything else is the real
 * code path against real PG.
 *
 * The eligibility probe replicates `readFrontierFeatures`' gating WHERE
 * (lib/dbos/orchestrator-loop.ts) against harness_features_consolidated —
 * view-transparent per that function's own doc: the work_items view's feature
 * half is SELECT * over consolidated.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const reg = vi.hoisted(() => ({ registered: new Set<string>() }));

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    // Same shape as the real withWorkspace (tx + workspace GUC), bound to the
    // scratch DB. The test client is the table owner, so ENABLE RLS does not
    // filter — workspace scoping is asserted via explicit column predicates.
    withWorkspace: async (ws: string, fn: (tx: postgres.Sql) => Promise<unknown>) =>
      h.sql.begin(async (tx) => {
        await (tx as unknown as postgres.Sql)`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return fn(tx as unknown as postgres.Sql);
      }),
  };
});
vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('../../harness-core', async () => {
  const actual = await vi.importActual<typeof import('../../harness-core')>('../../harness-core');
  return {
    ...actual,
    resolveProject: async (slug: string) =>
      reg.registered.has(slug) ? { slug, path: `/tmp/${slug}` } : null,
  };
});

const { executeSpawnChild, buildDefaultSpawnChildDeps, childSeedSlug } = await import('./spawn-child');
const { notifyParentOnDone } = await import('../../dbos/notify-parent-done');
type Deps = import('./spawn-child').SpawnChildDeps;
type ImportPayload = Parameters<Deps['importFeatures']>[1];

const WS = 'default';
const CHILD_SLUG = 'scratch-child';
const DATE = '2026-06-07';
const SEED = childSeedSlug(CHILD_SLUG, DATE);

/** harness_plans — the columns withPlanLock writes + the op_* start columns
 *  (mirrors migration 122 + 125/128 normalize + 284 initiative; PK identical). */
const HARNESS_PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
    title text, status text, created text, updated text, owner text,
    supersedes text[] DEFAULT '{}'::text[] NOT NULL, superseded_by text,
    content text DEFAULT '' NOT NULL, content_hash text DEFAULT '' NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    op_status text, op_started_at timestamptz, op_updated_at timestamptz,
    current_wave text, op_priority integer,
    archived boolean DEFAULT false NOT NULL, is_legacy boolean DEFAULT false NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL, decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    now_state text, now_next text, origin text DEFAULT 'local' NOT NULL,
    initiative text,
    created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug))`;

/** harness_plan_assertions — mirrors archive/087 + 088 (requires_test). */
const ASSERTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plan_assertions (
    workspace_id text NOT NULL, harness_slug text NOT NULL, val_id text NOT NULL,
    plan_slug text NOT NULL, item_id text NOT NULL,
    verify_text text NOT NULL, evidence_text text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'todo', requires_test boolean NOT NULL DEFAULT true,
    created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, val_id))`;

/** harness_features_consolidated — the columns the import lands + the
 *  dispatcher eligibility read needs (status/metadata/item_kind/origin/…). */
const HFC_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    workspace_id text NOT NULL DEFAULT 'default',
    harness_slug text NOT NULL, feature_id text NOT NULL,
    title text, summary text, status text NOT NULL DEFAULT 'todo',
    item_kind text NOT NULL DEFAULT 'feature',
    metadata jsonb, claims text,
    source_plan_slug text, source_plan_item_ids jsonb, wave text,
    feature_order integer, origin text, audit_verdict text,
    PRIMARY KEY (harness_slug, feature_id))`;

let db: FreshPgDb;

/** Simulates POST /features/import + the consolidated trigger: upsert by id —
 *  the same id-keyed idempotency the real route has. */
async function fakeImport(childSlug: string, payload: ImportPayload) {
  for (const f of payload) {
    await h.sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         metadata, claims, source_plan_slug, source_plan_item_ids, origin)
      VALUES
        (${WS}, ${childSlug}, ${f.id}, ${f.title}, ${f.summary ?? null}, 'todo', 'feature',
         ${JSON.stringify(f.metadata)}::text::jsonb,
         ${f.claims && f.claims.length > 0 ? JSON.stringify(f.claims) : null},
         ${f.source_plan_slug}, ${JSON.stringify(f.source_plan_item_ids)}::text::jsonb, 'local')
      ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
        title = EXCLUDED.title, summary = EXCLUDED.summary
    `;
  }
  return { ids: payload.map((f) => f.id), inserted: payload.length, updated: 0 };
}

/** The PG-visible side of doScaffoldHarness: per-harness schema + registration. */
function makeDeps(): Deps {
  const real = buildDefaultSpawnChildDeps({ importFeatures: fakeImport });
  return {
    ...real,
    resolveChild: async (slug) => reg.registered.has(slug),
    scaffold: async (_parentSlug, child) => {
      await h.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_${child.slug.replace(/-/g, '_')}`);
      reg.registered.add(child.slug);
      return { ok: true as const };
    },
  };
}

const SPAWN_OPTS = {
  child: { slug: CHILD_SLUG, template: 'node-cli', goal: 'Scratch child for the spawn e2e' },
  waveId: 'extract',
  parentSlug: 'papercup',
  parentPlanSlug: 'parent-plan-2026-06-01',
  features: [
    { title: 'Feature one', acceptance: ['one verifies'], from_items: ['P-001'] },
    { title: 'Feature two', acceptance: ['two verifies', 'two also builds'] },
  ],
  date: DATE,
};

/**
 * The dispatcher's plan-gated eligibility read, replicated verbatim from
 * readFrontierFeatures (lib/dbos/orchestrator-loop.ts) — features with no plan
 * are always eligible; plan features only when their plan is op_status='started'.
 * Queried against consolidated directly (the work_items view's feature half is
 * SELECT * over consolidated — view-transparent, per that function's doc).
 */
async function dispatcherEligibleIds(slug: string): Promise<string[]> {
  const rows = await h.sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${WS}
       AND harness_slug = ${slug}
       AND item_kind = 'feature'
       AND (
         (metadata->>'source_plan') IS NULL
         OR (metadata->>'source_plan') IN (
           SELECT plan_slug
             FROM harness_shared.harness_plans
            WHERE workspace_id = ${WS}
              AND harness_slug = ${slug}
              AND op_status = 'started'
         )
       )
       AND (origin = 'local' OR origin IS NULL OR audit_verdict = 'admit')
     ORDER BY feature_id
  `;
  return rows.map((r) => r.feature_id);
}

beforeAll(async () => {
  db = await createFreshPgDb('spawn-child');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_PLANS_DDL);
  await db.sql.unsafe(ASSERTIONS_DDL);
  await db.sql.unsafe(HFC_DDL);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

describe('executeSpawnChild against real PG (scratch workspace)', () => {
  it('scaffold → seed plan → import → start: the full green bar', async () => {
    const r = await executeSpawnChild(SPAWN_OPTS, makeDeps());

    expect(r.warnings).toEqual([]);
    expect(r).toMatchObject({
      child_slug: CHILD_SLUG,
      seed_plan_slug: SEED,
      scaffold: 'created',
      seed_plan: 'created',
      feature_ids: ['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002'],
      assertions_written: 3,
      started: true,
    });

    // 1. Child schema exists.
    const schemas = await db.sql<{ schema_name: string }[]>`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'harness_scratch_child'
    `;
    expect(schemas).toHaveLength(1);

    // 2. Child seed plan exists in the CHILD's plans scope and is STARTED.
    const plans = await db.sql<
      { plan_slug: string; status: string; op_status: string; version: number; content: string }[]
    >`
      SELECT plan_slug, status, op_status, version::int AS version, content
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
    `;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ plan_slug: SEED, status: 'active', op_status: 'started', version: 1 });
    expect(plans[0].content).toContain('- **P-001** `todo` Feature one');

    // 3. Child features carry the seed slug (column + the dispatcher's metadata key).
    const feats = await db.sql<
      { feature_id: string; source_plan_slug: string; meta_plan: string; claims: string | null }[]
    >`
      SELECT feature_id, source_plan_slug, metadata->>'source_plan' AS meta_plan, claims
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
       ORDER BY feature_id
    `;
    expect(feats.map((f) => f.feature_id)).toEqual(['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002']);
    for (const f of feats) {
      expect(f.source_plan_slug).toBe(SEED);
      expect(f.meta_plan).toBe(SEED);
    }
    expect(JSON.parse(feats[0].claims!)).toEqual([`VAL-${SEED}-001`]);
    expect(JSON.parse(feats[1].claims!)).toEqual([`VAL-${SEED}-002`, `VAL-${SEED}-003`]);

    // 4. The VAL assertions landed in the child scope, test-gated by default.
    const vals = await db.sql<{ val_id: string; item_id: string; requires_test: boolean }[]>`
      SELECT val_id, item_id, requires_test
        FROM harness_shared.harness_plan_assertions
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG} AND plan_slug = ${SEED}
       ORDER BY val_id
    `;
    expect(vals).toHaveLength(3);
    expect(vals[0]).toMatchObject({ val_id: `VAL-${SEED}-001`, item_id: 'P-001', requires_test: true });

    // 5. THE DISPATCHER WOULD PICK THEM UP: the started seed plan makes the
    //    features pass readFrontierFeatures' plan gate.
    expect(await dispatcherEligibleIds(CHILD_SLUG)).toEqual([
      'F-SCRATCH-CHILD-SEED-001',
      'F-SCRATCH-CHILD-SEED-002',
    ]);
  });

  it('the started plan is the load-bearing gate — an unstarted plan is ineligible', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, metadata, origin)
      VALUES (${WS}, ${CHILD_SLUG}, 'F-ORPHAN-001', 'orphan', 'todo', 'feature',
              ${JSON.stringify({ source_plan: 'never-started-plan' })}::text::jsonb, 'local')
    `;
    const eligible = await dispatcherEligibleIds(CHILD_SLUG);
    expect(eligible).not.toContain('F-ORPHAN-001');
    expect(eligible).toEqual(['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002']);
  });

  it('P-004: afterDone builtin posts a Completion to the sealed parent once the queue drains', async () => {
    // The PG side doScaffoldHarness seals: projects.parent_slug = caller.
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.projects (slug text PRIMARY KEY, parent_slug text)`);
    await db.sql`
      INSERT INTO harness_shared.projects (slug, parent_slug) VALUES (${CHILD_SLUG}, 'papercup')
      ON CONFLICT (slug) DO UPDATE SET parent_slug = EXCLUDED.parent_slug`;
    // The send rides dispatchAction → doSendMessage: the PARENT's inbox view +
    // the CHILD's executed_actions (rate-limit window) — per-harness surfaces
    // scaffoldHarnessSchema normally provisions; plain tables suffice here.
    await db.sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS harness_papercup;
      CREATE TABLE IF NOT EXISTS harness_papercup.messages (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        from_slug text, to_slug text, to_role text, from_feature_id text, to_feature_id text,
        kind text, subject text, body text, parent_message_id text, status text,
        acknowledged_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS harness_scratch_child.executed_actions (
        op text, executed_at timestamptz DEFAULT now())`);

    // Queue NOT drained (a sibling feature is still todo) → no message.
    const early = await notifyParentOnDone({
      harnessSlug: CHILD_SLUG,
      workspaceId: WS,
      featureId: 'F-SCRATCH-CHILD-SEED-001',
    });
    expect(early).toMatchObject({ notified: false, parent: 'papercup', reason: 'queue_not_drained' });

    // Drain the queue → the Completion lands in the parent's inbox.
    await db.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET status = 'passed'
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}`;
    const done = await notifyParentOnDone({
      harnessSlug: CHILD_SLUG,
      workspaceId: WS,
      featureId: 'F-SCRATCH-CHILD-SEED-002',
    });
    expect(done).toEqual({ notified: true, parent: 'papercup' });

    const msgs = await db.sql<{ from_slug: string; to_slug: string; kind: string; subject: string }[]>`
      SELECT from_slug, to_slug, kind, subject FROM harness_papercup.messages
    `;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from_slug: CHILD_SLUG,
      to_slug: 'papercup',
      kind: 'Completion',
      subject: `mission DONE: ${CHILD_SLUG}`,
    });
  });

  it('P-004: a harness with no sealed parent notifies no one', async () => {
    const r = await notifyParentOnDone({ harnessSlug: 'parentless', workspaceId: WS });
    expect(r).toEqual({ notified: false, reason: 'no_parent' });
  });

  it('re-running the same spawn is idempotent (D-004 retry): no duplicates, no version churn', async () => {
    const r = await executeSpawnChild(SPAWN_OPTS, makeDeps());
    expect(r.scaffold).toBe('already_existed');
    expect(r.seed_plan).toBe('already_existed');
    expect(r.started).toBe(true);
    expect(r.feature_ids).toEqual(['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002']);

    const plans = await db.sql<{ n: number; v: number }[]>`
      SELECT count(*)::int AS n, max(version)::int AS v
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
    `;
    expect(plans[0]).toEqual({ n: 1, v: 1 }); // existing seed kept, no rewrite

    const feats = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
         AND feature_id LIKE 'F-SCRATCH-CHILD-SEED-%'
    `;
    expect(feats[0].n).toBe(2); // deterministic ids upserted, not duplicated
  });
});
