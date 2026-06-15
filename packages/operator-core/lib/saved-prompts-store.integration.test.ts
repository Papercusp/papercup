/**
 * saved-prompts-store.integration.test.ts — the cross-client saved-prompts CRUD
 * (`harness_shared.saved_prompts`, migration 105) against real Postgres.
 *
 * This module is transport-agnostic: every function TAKES the `sql` handle, so
 * no db-org mock is needed — we pass the org-fixture's admin (RLS-bypass) client
 * directly. Validates: scope-filtered list (workspace-global vs per-harness),
 * upsert insert→update-in-place on the (workspace, COALESCE(harness,''), name)
 * unique key, workspace isolation, and remove's row-count return.
 *
 * Part of whole-app-test-coverage-breadth-2026-06-14 P-006 (integration tier).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  listSavedPrompts,
  upsertSavedPrompt,
  removeSavedPrompt,
} from './saved-prompts-store';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('saved_prompts store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('upserts a workspace-scoped prompt and reads it back (harness_slug NULL)', async () => {
    const ws = 'ws-sp-ws';
    const row = await upsertSavedPrompt(db.adminSql, {
      workspaceId: ws,
      scope: { kind: 'workspace' },
      name: 'deploy',
      body: 'run the deploy',
      description: 'ship it',
      argHint: '[env]',
    });
    expect(row.workspaceId).toBe(ws);
    expect(row.harnessSlug).toBeNull();
    expect(row.name).toBe('deploy');
    expect(row.body).toBe('run the deploy');
    expect(row.description).toBe('ship it');
    expect(row.argHint).toBe('[env]');
    expect(typeof row.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);

    const list = await listSavedPrompts(db.adminSql, ws, { kind: 'workspace' });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('deploy');
  });

  it('upsert updates body/description/arg_hint in place for the same scope+name', async () => {
    const ws = 'ws-sp-upsert';
    const first = await upsertSavedPrompt(db.adminSql, {
      workspaceId: ws,
      scope: { kind: 'workspace' },
      name: 'note',
      body: 'first body',
    });
    const second = await upsertSavedPrompt(db.adminSql, {
      workspaceId: ws,
      scope: { kind: 'workspace' },
      name: 'note',
      body: 'second body',
      description: 'now described',
    });
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(second.body).toBe('second body');
    expect(second.description).toBe('now described');
    const list = await listSavedPrompts(db.adminSql, ws, { kind: 'workspace' });
    expect(list).toHaveLength(1);
  });

  it('separates workspace-scope from harness-scope under the same name', async () => {
    const ws = 'ws-sp-scope';
    await upsertSavedPrompt(db.adminSql, {
      workspaceId: ws,
      scope: { kind: 'workspace' },
      name: 'shared',
      body: 'ws body',
    });
    await upsertSavedPrompt(db.adminSql, {
      workspaceId: ws,
      scope: { kind: 'harness', slug: 'alpha' },
      name: 'shared',
      body: 'harness body',
    });
    const wsList = await listSavedPrompts(db.adminSql, ws, { kind: 'workspace' });
    const hList = await listSavedPrompts(db.adminSql, ws, { kind: 'harness', slug: 'alpha' });
    expect(wsList).toHaveLength(1);
    expect(wsList[0].body).toBe('ws body');
    expect(hList).toHaveLength(1);
    expect(hList[0].harnessSlug).toBe('alpha');
    expect(hList[0].body).toBe('harness body');
  });

  it('is workspace-scoped — another workspace\'s prompts are not returned', async () => {
    await upsertSavedPrompt(db.adminSql, {
      workspaceId: 'ws-sp-iso-a',
      scope: { kind: 'workspace' },
      name: 'p',
      body: 'a',
    });
    await upsertSavedPrompt(db.adminSql, {
      workspaceId: 'ws-sp-iso-b',
      scope: { kind: 'workspace' },
      name: 'p',
      body: 'b',
    });
    expect(await listSavedPrompts(db.adminSql, 'ws-sp-iso-a', { kind: 'workspace' })).toHaveLength(1);
    expect((await listSavedPrompts(db.adminSql, 'ws-sp-iso-a', { kind: 'workspace' }))[0].body).toBe('a');
  });

  it('lists scope rows newest-name-first (ORDER BY name) and removes by name', async () => {
    const ws = 'ws-sp-remove';
    await upsertSavedPrompt(db.adminSql, { workspaceId: ws, scope: { kind: 'workspace' }, name: 'b-second', body: 'x' });
    await upsertSavedPrompt(db.adminSql, { workspaceId: ws, scope: { kind: 'workspace' }, name: 'a-first', body: 'y' });
    const ordered = await listSavedPrompts(db.adminSql, ws, { kind: 'workspace' });
    expect(ordered.map((r) => r.name)).toEqual(['a-first', 'b-second']);

    expect(await removeSavedPrompt(db.adminSql, ws, { kind: 'workspace' }, 'a-first')).toBe(true);
    // removing a non-existent name returns false
    expect(await removeSavedPrompt(db.adminSql, ws, { kind: 'workspace' }, 'a-first')).toBe(false);
    expect(await listSavedPrompts(db.adminSql, ws, { kind: 'workspace' })).toHaveLength(1);
  });
});
