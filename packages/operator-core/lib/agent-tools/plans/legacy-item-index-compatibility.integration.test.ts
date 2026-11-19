import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { hashPlanContent } from './content-hash';
import { deriveIndexFromContent } from './derive-index';

const connection = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
  withWorkspace: async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => db.sql.begin((tx) => fn(tx)),
}));
vi.mock('../../hive-federation', async (original) => ({
  ...(await original<typeof import('../../hive-federation')>()),
  // This test uses a fixture Hive slug and does not exercise registry resolution.
  potHomeSlugForHarness: async (_workspaceId: string, harnessSlug: string) => harnessSlug,
}));

import { readExecutionPlanRow } from './plan-execution-authority';
import { readPlanLineItems } from './plan-line-graph';
import { getPlanItemRow, getPlanRow, listPlanIndexRows, planItemsForRow } from './source';

let db: FreshPgDb;
const workspaceId = 'plan-line-compat-ws';
const harnessSlug = 'plan-line-compat';
const body = [
  '---',
  'title: Compatibility fixture',
  'status: draft',
  '---',
  '# Compatibility fixture',
  '',
  '## Phase 1',
  '- **P-001** \u0060todo\u0060 First task',
  '- **P-002** \u0060blocked\u0060 Second task blocked-by: P-001',
  '',
].join(String.fromCharCode(10));
const scope = { workspaceId, harnessSlug };

function compact(items: readonly { id: string; text: string; blockedBy: string[] }[]) {
  return items.map(({ id, text, blockedBy }) => ({ id, text, blockedBy }));
}

async function seedPlan(slug: string, content: string, items: unknown): Promise<void> {
  await db.sql.unsafe(
    'INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, items) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::text::jsonb)',
    [workspaceId, harnessSlug, slug, content, hashPlanContent(content), 'Compatibility fixture', 'draft', JSON.stringify(items)],
  );
}

async function seedGraphItem(slug: string, id: string, text: string, sequence: number): Promise<void> {
  await db.sql.unsafe(
    'INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, plan_slug, plan_line_id, plan_seq, plan_phase, plan_importance, plan_decision_refs, plan_deliverable, plan_owner_gate_marker, plan_line_text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $14, $15, $16)',
    [workspaceId, harnessSlug, `WI-${slug}-${id}`, text, text, 'open', 'feature', slug, id, sequence, 'Phase 1', 'normal', [], null, null, text],
  );
}

beforeAll(async () => {
  db = await createFreshPgDb('planlinecompat');
  connection.sql = db.sql;
  await db.sql.unsafe([
    'CREATE TABLE harness_shared.harness_plans (',
    '  workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,',
    '  content text NOT NULL, content_hash text NOT NULL, version integer NOT NULL DEFAULT 1,',
    '  title text, status text, created text, updated text, owner text, initiative text,',
    "  supersedes text[] NOT NULL DEFAULT '{}', superseded_by text, op_status text,",
    '  op_started_at timestamptz, op_updated_at timestamptz, current_wave integer, op_priority integer,',
    '  archived boolean NOT NULL DEFAULT false, is_legacy boolean NOT NULL DEFAULT false,',
    '  updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),',
    "  items jsonb NOT NULL DEFAULT '[]'::jsonb, decisions jsonb NOT NULL DEFAULT '[]'::jsonb,",
    '  now_state text, now_next text, now_note jsonb, promote_policy jsonb,',
    '  schedule jsonb, schedule_active boolean, scheduled_at timestamptz, expires_at timestamptz,',
    '  tzid text, template_slug text, run_seq integer, template text, template_data jsonb,',
    '  input_schema jsonb, output_schema jsonb, forced_past jsonb,',
    '  verification_profile text, verification_profile_source text,',
    '  is_blender_origin boolean NOT NULL DEFAULT false,',
    '  PRIMARY KEY (workspace_id, harness_slug, plan_slug)',
    ');',
    'CREATE TABLE harness_shared.work_items (',
    '  workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,',
    '  title text, summary text, status text, item_kind text, plan_slug text, plan_line_id text,',
    '  plan_seq integer, plan_phase text, plan_importance text, plan_decision_refs text[],',
    '  plan_deliverable text, plan_owner_gate_marker text, plan_line_text text',
    ');',
    'CREATE TABLE harness_shared.work_item_deps (',
    '  workspace_id text, dep_type text, blocked_kind text, blocked_ref text, blocker_kind text, blocker_ref text',
    ');',
    'CREATE TABLE harness_shared.trigger_bindings (',
    '  workspace_id text, plan_harness_slug text, plan_slug text, action jsonb, detached_at timestamptz',
    ');',
  ].join(String.fromCharCode(10)));
});

beforeEach(async () => {
  await db.sql.unsafe('DELETE FROM harness_shared.work_item_deps');
  await db.sql.unsafe('DELETE FROM harness_shared.work_items');
  await db.sql.unsafe('DELETE FROM harness_shared.harness_plans');
});

afterAll(async () => {
  if (db) await db.cleanup();
});

describe('old writer JSON item index compatibility', () => {
  it('preserves item IDs and dependencies across current plan readers when graph rows are absent', async () => {
    const oldIndex = deriveIndexFromContent(body).items;
    // The d740fc3802 writer persisted this derived JSON index but had no graph-line write.
    await seedPlan('old-writer', body, oldIndex);

    const [persisted] = await db.sql<{ items: unknown; content: string }[]>`
      SELECT items, content
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = 'old-writer'
    `;
    if (!persisted) throw new Error('compatibility fixture row not persisted');
    expect(persisted.items).toEqual(oldIndex);
    expect(persisted.content).toBe(body);
    const directItems = await db.sql.begin((tx) =>
      readPlanLineItems(tx as unknown as Sql, { ...scope, slug: 'old-writer' }, persisted),
    );

    const plan = await getPlanRow('old-writer', scope);
    const itemRow = await getPlanItemRow('old-writer', scope);
    const listed = await listPlanIndexRows({ ...scope, includeItems: true, limit: 10 });
    const listedPlan = listed.find((candidate) => candidate.planSlug === 'old-writer');
    const execution = await readExecutionPlanRow({ ...scope, planSlug: 'old-writer' });
    if (!plan || !itemRow || !listedPlan || !execution) throw new Error('compatibility fixture read missing');

    const expected = [
      { id: 'P-001', text: 'First task', blockedBy: [] },
      { id: 'P-002', text: 'Second task', blockedBy: ['P-001'] },
    ];
    expect(compact(directItems)).toEqual(expected);
    expect(compact(plan.items)).toEqual(expected);
    expect(compact(planItemsForRow(itemRow))).toEqual(expected);
    expect(compact(listedPlan.items)).toEqual(expected);
    expect(execution.rendered_content).toContain('P-001');
    expect(execution.rendered_content).toContain('P-002');
    expect(execution.rendered_content).toContain('blocked-by: P-001');
  });

  it('keeps explicit empty and mismatched JSON indexes from reviving stale markdown', async () => {
    const staleBody = body.replace('P-002', 'P-099').replace('Second task', 'Stale task');
    const differentBody = body.replace('P-002', 'P-003').replace('Second task', 'Different task');
    await seedPlan('indexed-empty', staleBody, []);
    await seedPlan('index-mismatch', differentBody, deriveIndexFromContent(body).items);

    const empty = await getPlanRow('indexed-empty', scope);
    const mismatch = await getPlanRow('index-mismatch', scope);
    const listed = await listPlanIndexRows({ ...scope, includeItems: true, limit: 10 });
    const listedEmpty = listed.find((candidate) => candidate.planSlug === 'indexed-empty');
    const listedMismatch = listed.find((candidate) => candidate.planSlug === 'index-mismatch');
    if (!empty || !mismatch || !listedEmpty || !listedMismatch) throw new Error('control fixture read missing');

    expect(empty.items).toEqual([]);
    expect(mismatch.items).toEqual([]);
    expect(listedEmpty.items).toEqual([]);
    expect(listedMismatch.items).toEqual([]);
    expect(empty.content).not.toContain('P-099');
    expect(mismatch.content).not.toContain('P-003');
  });

  it.each([21, 22, 23])('reports the complete missing population after %i represented items in either saved order', async count => {
    for (const reversed of [false, true]) {
      const slug = `partial-${count}-${reversed}`;
      const lines = Array.from({ length: count + 3 }, (_, i) =>
        `- **P-${String(i + 1).padStart(3, '0')}** \u0060todo\u0060 Task ${i + 1}`);
      const content = body.slice(0, body.indexOf('- **P-001**'))
        + (reversed ? [...lines].reverse() : lines).join('\n') + '\n';
      await seedPlan(slug, content, deriveIndexFromContent(content).items);
      for (let i = 0; i < count; i++) {
        await seedGraphItem(slug, `P-${String(i + 1).padStart(3, '0')}`, `Task ${i + 1}`, i);
      }
      const missing = Array.from({ length: 3 }, (_, i) => `P-${String(count + i + 1).padStart(3, '0')}`);
      const message = /plan_line_graph_incomplete/;
      for (const read of [
        () => getPlanRow(slug, scope),
        () => getPlanItemRow(slug, scope),
        () => readExecutionPlanRow({ ...scope, planSlug: slug }),
        () => listPlanIndexRows({ ...scope, includeItems: true, limit: 10 }),
      ]) {
        let failure: unknown;
        try { await read(); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        const text = (failure as Error).message;
        expect(text).toMatch(message);
        for (const id of missing) expect(text).toContain(id);
        expect(text).toContain('plans:backfill-dependency-edges');
        expect(text).toContain(hashPlanContent(content));
        expect(text).toContain('expectedVersion');
      }
      // Simulate the additive materialization's result: subsequent consumers
      // recover the entire population and keep graph-owned text authoritative.
      for (const [i, id] of missing.entries()) {
        await seedGraphItem(slug, id, `Recovered ${id}`, count + i);
        // Each fresh read sees durable progress, while an unreconciled tail
        // still prevents a complete-population claim after partial recovery.
        for (const remaining of missing.slice(i + 1)) {
          await expect(getPlanRow(slug, scope)).rejects.toThrow(remaining);
        }
      }
      expect((await getPlanRow(slug, scope))?.items).toHaveLength(count + 3);
      expect((await getPlanItemRow(slug, scope))?.items).toHaveLength(count + 3);
      expect((await listPlanIndexRows({ ...scope, includeItems: true, limit: 10 }))
        .find(plan => plan.planSlug === slug)?.items).toHaveLength(count + 3);
    }
  });

  it('prefers current graph text over an otherwise matching legacy index without omitting saved IDs', async () => {
    await seedPlan('graph-wins', body, deriveIndexFromContent(body).items);
    await seedGraphItem('graph-wins', 'P-001', 'Graph text', 0);
    await seedGraphItem('graph-wins', 'P-002', 'Graph second task', 1);

    const plan = await getPlanRow('graph-wins', scope);
    const listed = await listPlanIndexRows({ ...scope, includeItems: true, limit: 10 });
    const listedPlan = listed.find((candidate) => candidate.planSlug === 'graph-wins');
    if (!plan || !listedPlan) throw new Error('graph fixture read missing');

    expect(plan.items.map((item) => item.id)).toEqual(['P-001', 'P-002']);
    expect(plan.items[0]?.text).toBe('Graph text');
    expect(listedPlan.items.map((item) => item.id)).toEqual(['P-001', 'P-002']);
    expect(listedPlan.items[0]?.text).toBe('Graph text');
  });
});
