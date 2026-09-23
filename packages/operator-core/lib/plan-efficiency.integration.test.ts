/**
 * plan-efficiency.integration.test.ts — review-system-rework-reduction-2026-09-23 P-032 guard.
 *
 * A fixture plan whose seeded tool_invocations rows are known exactly must come back from
 * readPlanEfficiency with category, failure, dropped-effort, holder and wall-clock counts that
 * match those rows — and every row that is NOT the plan's (observation-lane item, another plan's
 * item, a non-agent call, another workspace, a transcript part outside the corpus workspace or
 * outside the plan's window) must be excluded. Real Postgres via the org test fixture; the reader
 * takes its postgres-js client as an argument, so nothing is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { readPlanEfficiency } = await import('./plan-efficiency');

const WS = 'ws-plan-efficiency';
const HARNESS = 'papercusp';
const PLAN = 'plan-efficiency-fixture';
const T0 = Date.parse('2026-09-01T10:00:00Z');
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

let nextId = 1;

describe('readPlanEfficiency (real PG)', () => {
  let db: OrgTestDb;

  async function item(featureId: string, status: string, opts: { plan?: string; lane?: string } = {}) {
    // `lane` is GENERATED from payload->>'lane', so the observation lane rides in the payload.
    const payload = opts.lane ? { lane: opts.lane } : {};
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, source_plan_slug, payload)
      VALUES (${WS}, ${HARNESS}, ${featureId}, ${`fixture ${featureId}`}, ${status}, 'feature',
              ${opts.plan ?? PLAN}, ${db.adminSql.json(payload)})`;
  }

  async function call(
    goalRef: string,
    owner: string,
    tool: string,
    offsetSec: number,
    opts: { status?: string; errorCode?: string | null; origin?: string; ws?: string } = {},
  ) {
    const id = nextId++;
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, coord_owner_id,
         invoked_at, window_key, status, error_code, transport, call_origin, goal_ref)
      VALUES
        (${id}, ${opts.ws ?? WS}, ${HARNESS}, 'core', ${tool}, 'su', ${`sp-${id}`}, ${owner},
         ${at(offsetSec)}::timestamptz, 'w', ${opts.status ?? 'ok'}, ${opts.errorCode ?? null}, 'mcp',
         ${opts.origin ?? 'agent'}, ${goalRef})`;
  }

  async function part(owner: string, offsetSec: number, ws = 'default') {
    const idx = nextId++;
    await db.adminSql`
      INSERT INTO harness_shared.session_turn_parts
        (workspace_id, source_kind, session_id, part_idx, ts, owner, speaker, part_kind, tool_name, text)
      VALUES (${ws}, 'claude', ${`sess-${owner}`}, ${idx}, ${at(offsetSec)}::timestamptz, ${owner},
              'assistant', 'text', null, 'fixture')`;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();

    await item('WI-A', 'done');
    await item('WI-B', 'done');
    await item('WI-C', 'dropped');
    await item('WI-D', 'open');
    await item('WI-O', 'open', { lane: 'observation' });
    await item('WI-X', 'done', { plan: 'some-other-plan' });

    // The plan's attributed calls: 8 in total.
    await call('WI-A', 'a1', 'capability:bash', 0);
    await call('WI-A', 'a1', 'capability:bash', 30);
    await call('WI-A', 'a1', 'coord:send', 60);
    await call('WI-A', 'a2', 'testing:run', 600);
    await call('WI-B', 'a1', 'rubrics:amend', 900, { status: 'invalid-input', errorCode: 'invalid_input' });
    await call('WI-B', 'a1', 'scorecards:emit', 960);
    await call('WI-C', 'a2', 'plans:get', 1200);
    await call('WI-C', 'a2', 'release:checkpoint-run', 1260, { status: 'error' });

    // Rows that must NOT be counted.
    await call('WI-O', 'a1', 'capability:bash', 100); // observation-lane item
    await call('WI-X', 'a3', 'coord:send', 100); // another plan's item
    await call('WI-A', 'a4', 'capability:bash', 5000, { origin: 'system' }); // not an agent call
    await call('WI-A', 'a5', 'capability:bash', 100, { ws: 'other-ws' }); // another workspace

    // Transcript parts. a1: gaps 60 (active) and 900 (idle). a2: gaps 600 (idle) and 60 (active).
    await part('a1', 0);
    await part('a1', 60);
    await part('a1', 960);
    await part('a2', 600);
    await part('a2', 1200);
    await part('a2', 1260);
    // Excluded parts: outside the plan window, and outside the corpus workspace.
    await part('a1', -7200);
    await part('a1', 30, WS);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('counts exactly the seeded rows of the plan, by purpose', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, sql: db.adminSql });

    expect(eff.items).toEqual({ total: 4, byStatus: { done: 2, dropped: 1, open: 1 } });
    expect(eff.calls.total).toBe(8);
    expect(eff.calls.agents).toBe(2);
    expect(eff.calls.activeHours).toBe(1);
    expect(eff.calls.firstAt).toBe(at(0));
    expect(eff.calls.lastAt).toBe(at(1260));
    expect(eff.calls.byCategory).toEqual({
      'generic-exec': 2,
      'coordination-carry': 1,
      'read-orient': 1,
      'acceptance-ceremony': 2,
      'gate-pipeline': 1,
      'implementation-test': 1,
      other: 0,
    });
  });

  it('classes failed calls, counts effort on dropped items, and counts holder changes', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, sql: db.adminSql });

    expect(eff.failed).toEqual({ total: 2, share: 0.25, byClass: { invalid_input: 1, error: 1 } });
    expect(eff.droppedEffort).toEqual({ calls: 2, items: 1, itemIds: ['WI-C'] });
    expect(eff.holders).toEqual({
      itemsWorked: 3,
      itemsWithHolderChange: 1,
      holderChanges: 1,
      mostHandled: [{ itemId: 'WI-A', holders: 2 }],
    });
  });

  it('splits holders wall-clock into active and idle inside the plan window only', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, sql: db.adminSql });

    expect(eff.wallClock).toMatchObject({
      scope: 'holders-across-plan-window',
      owners: 2,
      activeSec: 120,
      idleSec: 1500,
      awaySec: 0,
      idleGaps: 2,
    });
    expect(eff.population.floor).toBe(true);
  });

  it('returns zeros, not an error, for a plan with no work items', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: 'no-such-plan', sql: db.adminSql });

    expect(eff.items.total).toBe(0);
    expect(eff.calls.total).toBe(0);
    expect(eff.calls.firstAt).toBeNull();
    expect(eff.wallClock.owners).toBe(0);
  });
});
