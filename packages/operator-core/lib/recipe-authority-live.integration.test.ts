import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { recipeAuthorityMatchesCurrentRefs, type RecipeAuthorityDescriptor } from './recipe-authority';
import { ACTIVATION_QUALITY_PUBLICATION_SCRIPT } from './agent-tools/recipes/activation-quality-publication';
import { TERMINAL_INPUT_STATES } from './work-item-dispatch-states';

describe('pre-activation recipe custody (real PG)', () => {
  let db: FreshPgDb;
  const refs = { workspaces: [], fleets: [], plans: ['draft-plan'], harnesses: ['alpha'], items: [], resources: [] };
  const descriptor: RecipeAuthorityDescriptor = { refs, bound: true, unresolved: false };
  const liveRefs = { plans: [], items: [], resources: [] };
  const check = (overrides: Partial<Parameters<typeof recipeAuthorityMatchesCurrentRefs>[0]> = {}) =>
    recipeAuthorityMatchesCurrentRefs({ sql: db.sql, workspaceId: 'workspace', ownerId: 'startup-owner',
      script: ACTIVATION_QUALITY_PUBLICATION_SCRIPT, descriptor, liveRefs, ...overrides });

  beforeAll(async () => {
    db = await createFreshPgDb('recipe_control');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.work_items (
        workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
        taken_by text, status text NOT NULL DEFAULT 'open', parent_id text,
        source_plan_slug text, plan_slug text, plan_line_id text, payload jsonb DEFAULT '{}',
        PRIMARY KEY(workspace_id,harness_slug,feature_id));
      CREATE TABLE harness_shared.harness_plans (
        workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
        status text NOT NULL DEFAULT 'draft', execution_start_revision_seq bigint,
        execution_start_invalidation jsonb, PRIMARY KEY(workspace_id,harness_slug,plan_slug));
      CREATE TABLE harness_shared.plan_items (
        workspace_id text, harness_slug text, plan_slug text, item_id text);
    `).simple();
  });
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.work_items, harness_shared.harness_plans, harness_shared.plan_items`;
    await db.sql`INSERT INTO harness_shared.harness_plans(workspace_id,harness_slug,plan_slug)
      VALUES ('workspace','alpha','draft-plan')`;
    await db.sql`INSERT INTO harness_shared.plan_items VALUES ('workspace','alpha','draft-plan','P-001')`;
  });

  async function bootstrap() {
    await db.sql`INSERT INTO harness_shared.work_items(workspace_id,harness_slug,feature_id,taken_by,payload)
      VALUES ('workspace','alpha','startup','startup-owner',
        ${JSON.stringify({ workDefinition: { verificationTarget: { target: 'draft-plan' } } })}::text::jsonb)`;
  }
  async function lineage(depth: number, reverse = false) {
    await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,taken_by,parent_id,plan_slug,plan_line_id)
      SELECT 'workspace','alpha','node-' || n, CASE WHEN n=0 THEN 'startup-owner' END,
        CASE WHEN n<${depth} THEN 'node-' || (n+1) END,
        CASE WHEN n=${depth} THEN 'draft-plan' END, CASE WHEN n=${depth} THEN 'P-001' END
        FROM generate_series(0,${depth}) g(n) ORDER BY CASE WHEN ${reverse} THEN -n ELSE n END`;
  }

  it('preserves the custody record as an object through PostgreSQL parameter serialization', async () => {
    const encoded = JSON.stringify({ workDefinition: { verificationTarget: { target: 'draft-plan' } } });
    const [wire] = await db.sql`SELECT jsonb_typeof(${encoded}::jsonb) AS inferred,
      jsonb_typeof(${encoded}::text::jsonb) AS explicit`;
    expect(wire).toEqual({ inferred: 'string', explicit: 'object' });
    await bootstrap();
    const [record] = await db.sql`SELECT jsonb_typeof(payload) AS kind,
      payload #>> '{workDefinition,verificationTarget,target}' AS target FROM harness_shared.work_items`;
    expect(record).toEqual({ kind: 'object', target: 'draft-plan' });
  });
  it('authorizes an exact recorded bootstrap without plan-item claims', async () => {
    await bootstrap();
    expect(await check()).toBe(true);
    expect(await check({ ownerId: 'foreign-owner' })).toBe(false);
    expect(await check({ workspaceId: 'foreign-workspace' })).toBe(false);
    expect(await check({ descriptor: { ...descriptor, refs: { ...refs, harnesses: ['foreign-harness'] } } })).toBe(false);
    expect(await check({ descriptor: { ...descriptor, refs: { ...refs, plans: ['foreign-plan'] } } })).toBe(false);
  });
  it.each([63, 64, 65, 129])('finds canonical startup ancestry at depth %i in either insertion order', async depth => {
    await lineage(depth, depth % 2 === 1);
    expect(await check()).toBe(true);
    // A fresh invocation remeasures custody; no warmed result survives release.
    await db.sql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE feature_id='node-0'`;
    expect(await check()).toBe(false);
    await db.sql`UPDATE harness_shared.work_items SET taken_by='startup-owner' WHERE feature_id='node-0'`;
    expect(await check()).toBe(true);
  });
  it.each(TERMINAL_INPUT_STATES)('denies terminal bootstrap custody: %s', async status => {
    await bootstrap();
    await db.sql`UPDATE harness_shared.work_items SET status=${status}`;
    expect(await check()).toBe(false);
  });
  it.each(['cancelled', 'unrecognized-state'])('fails closed on other custody state spellings: %s', async status => {
    await bootstrap();
    await db.sql`UPDATE harness_shared.work_items SET status=${status}`;
    expect(await check()).toBe(false);
  });
  it('denies a removed canonical plan line and ambiguous line mappings', async () => {
    await lineage(2);
    await db.sql`DELETE FROM harness_shared.plan_items`;
    expect(await check()).toBe(false);
    await db.sql`INSERT INTO harness_shared.plan_items VALUES ('workspace','alpha','draft-plan','P-001')`;
    await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,plan_slug,plan_line_id)
      VALUES ('workspace','alpha','duplicate','draft-plan','P-001')`;
    expect(await check()).toBe(false);
  });
  it('denies a cycle even when a matching witness precedes it', async () => {
    await lineage(2);
    await db.sql`UPDATE harness_shared.work_items SET parent_id='node-0' WHERE feature_id='node-2'`;
    expect(await check()).toBe(false);
  });
  it('does not fall back to a definition over a stale canonical identity', async () => {
    await bootstrap();
    await db.sql`UPDATE harness_shared.work_items SET plan_slug='foreign-plan',plan_line_id='P-999'`;
    expect(await check()).toBe(false);
  });
  it('denies a started or retired plan; invalidated starts still permit readiness work', async () => {
    await bootstrap();
    await db.sql`UPDATE harness_shared.harness_plans SET status='active',execution_start_revision_seq=7`;
    expect(await check()).toBe(false);
    await db.sql`UPDATE harness_shared.harness_plans SET execution_start_invalidation='{}'::jsonb`;
    expect(await check()).toBe(true);
    await db.sql`UPDATE harness_shared.harness_plans SET status='shipped'`;
    expect(await check()).toBe(false);
  });
  it('does not lend bootstrap authority to changed scripts, implementation or unrelated entities', async () => {
    await bootstrap();
    expect(await check({ script: ACTIVATION_QUALITY_PUBLICATION_SCRIPT + '\nreturn true;' })).toBe(false);
    expect(await check({ script: 'await tools.capability.write({file_path:"source.ts",content:"x"});' })).toBe(false);
    expect(await check({ descriptor: { ...descriptor, refs: { ...refs, items: ['unrelated-item'] } } })).toBe(false);
    expect(await check({ descriptor: { ...descriptor, refs: { ...refs, resources: ['unrelated-resource'] } } })).toBe(false);
  });
});
