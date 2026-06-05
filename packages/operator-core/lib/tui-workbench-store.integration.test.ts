/**
 * tui-workbench-store.integration.test.ts — real testcontainer PG.
 *
 * Exercises the pui workbench persistence CRUD (migration 138:
 * harness_shared.tui_layouts / tui_crews / tui_view_state) against the real
 * schema so a column/JSONB drift is caught. Covers: view_state upsert
 * round-trip + default {}; layout save/list/get/delete; crew save with members
 * + companion layout_name + member_count rollup; per-owner isolation; delete
 * returns whether a row matched.
 *
 * P12 / D-002 of tui-workbench-ratatui-2026-06-04.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as unknown as import('postgres').Sql }));

// Point getOrgPg at the throwaway DB; pin the workspace. (Partial mock keeps
// every other db-org export intact.)
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
  };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import {
  getViewState,
  putViewState,
  listLayouts,
  getLayout,
  putLayout,
  deleteLayout,
  listCrews,
  getCrew,
  putCrew,
  deleteCrew,
} from './tui-workbench-store';

// Table-only DDL (no RLS/GRANT — the test container has no harness_app role).
const DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.tui_layouts (
    workspace_id text NOT NULL, owner_id text NOT NULL, name text NOT NULL,
    kdl text NOT NULL, description text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, owner_id, name)
  );
  CREATE TABLE IF NOT EXISTS harness_shared.tui_crews (
    workspace_id text NOT NULL, owner_id text NOT NULL, name text NOT NULL,
    members jsonb NOT NULL DEFAULT '[]'::jsonb, layout_name text, description text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, owner_id, name)
  );
  CREATE TABLE IF NOT EXISTS harness_shared.tui_view_state (
    workspace_id text NOT NULL, owner_id text NOT NULL,
    state jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, owner_id)
  );
`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('tuiwb');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.tui_layouts, harness_shared.tui_crews, harness_shared.tui_view_state');
});

describe('tui-workbench-store — view_state', () => {
  it('returns {} when nothing saved', async () => {
    expect(await getViewState('u1')).toEqual({});
  });

  it('upserts + round-trips state, replacing on second write', async () => {
    await putViewState('u1', { tab: 'Plans', sel: 3 });
    expect(await getViewState('u1')).toEqual({ tab: 'Plans', sel: 3 });
    await putViewState('u1', { tab: 'Sessions' });
    expect(await getViewState('u1')).toEqual({ tab: 'Sessions' });
  });

  it('isolates per owner', async () => {
    await putViewState('u1', { tab: 'Plans' });
    expect(await getViewState('u2')).toEqual({});
  });
});

describe('tui-workbench-store — layouts', () => {
  it('saves, lists (summary, no kdl), gets full, deletes', async () => {
    await putLayout('u1', 'main', 'layout {\n  pane\n}', 'my main layout');
    const list = await listLayouts('u1');
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('main');
    expect(list[0]!.description).toBe('my main layout');
    expect(list[0]).not.toHaveProperty('kdl');

    const full = await getLayout('u1', 'main');
    expect(full?.kdl).toBe('layout {\n  pane\n}');

    expect(await deleteLayout('u1', 'main')).toBe(true);
    expect(await getLayout('u1', 'main')).toBeNull();
    expect(await deleteLayout('u1', 'main')).toBe(false);
  });

  it('upserts by (owner,name)', async () => {
    await putLayout('u1', 'main', 'v1');
    await putLayout('u1', 'main', 'v2', 'updated');
    expect((await listLayouts('u1')).length).toBe(1);
    expect((await getLayout('u1', 'main'))?.kdl).toBe('v2');
  });
});

describe('tui-workbench-store — crews', () => {
  it('saves members + companion layout, rolls up member_count, round-trips members', async () => {
    await putCrew(
      'u1',
      'morning',
      [
        { slot: 0, agent: 'claude', resume_id: 'r1', harness: 'papercup' },
        { slot: 1, agent: 'codex', plan: 'plan-x' },
      ],
      'main',
      'morning crew',
    );

    const list = await listCrews('u1');
    expect(list).toHaveLength(1);
    expect(list[0]!.member_count).toBe(2);
    expect(list[0]!.layout_name).toBe('main');

    const full = await getCrew('u1', 'morning');
    expect(full?.members).toHaveLength(2);
    expect(full?.members[0]).toMatchObject({ slot: 0, agent: 'claude', resume_id: 'r1' });
    expect(full?.layout_name).toBe('main');

    expect(await deleteCrew('u1', 'morning')).toBe(true);
    expect(await getCrew('u1', 'morning')).toBeNull();
  });

  it('defaults members to [] and tolerates an empty crew', async () => {
    await putCrew('u1', 'empty', []);
    const full = await getCrew('u1', 'empty');
    expect(full?.members).toEqual([]);
    expect((await listCrews('u1'))[0]!.member_count).toBe(0);
  });
});
