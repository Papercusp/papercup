/**
 * harness-prompt-overrides.integration.test.ts — the per-(workspace, harness,
 * role) prompt-override store (harnesses-across-workspaces D-7) against REAL
 * Postgres (testcontainer). Validates the upsert ON-CONFLICT, the explicit
 * (workspace_id, harness_slug, role) scoping, delete-returning, clear-all, and
 * list ordering against the full migrated baseline schema.
 *
 * The store routes every op through `getOrgPg().sql` as the table owner
 * (harness_admin, RLS-bypass — the table IS RLS-enabled but scoping is by the
 * explicit WHERE columns, not the GUC), so we mock getOrgPg to the fixture's
 * admin client. Isolation between cases is by a FRESH workspace_id per test
 * (mirrors the scout/tick-ledger fresh-key-per-test discipline).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const {
  getPromptOverride,
  setPromptOverride,
  deletePromptOverride,
  clearAllPromptOverrides,
  listPromptOverrides,
} = await import('./harness-prompt-overrides');
const { createOrgTestDb } = await import('../test/_org-test-db');

let wsCounter = 0;
const freshWs = () => `pov_${++wsCounter}_${randomBytes(2).toString('hex')}`;

describe('harness_prompt_overrides store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('upserts and reads back an override; unset returns null', async () => {
    const ws = freshWs();
    expect(await getPromptOverride(ws, 'harness-a', 'engineer')).toBeNull();
    await setPromptOverride(ws, 'harness-a', 'engineer', '# engineer override');
    expect(await getPromptOverride(ws, 'harness-a', 'engineer')).toBe('# engineer override');
  });

  it('ON CONFLICT (workspace, harness, role) overwrites the markdown (latest wins)', async () => {
    const ws = freshWs();
    await setPromptOverride(ws, 'harness-b', 'mug', 'first body');
    await setPromptOverride(ws, 'harness-b', 'mug', 'second body');
    expect(await getPromptOverride(ws, 'harness-b', 'mug')).toBe('second body');
    // Still exactly one row for that key — no duplicate inserted.
    const all = await listPromptOverrides(ws, 'harness-b');
    expect(all.filter((r) => r.role === 'mug')).toHaveLength(1);
  });

  it('is scoped by workspace AND harness AND role — neighbors are invisible', async () => {
    const wsA = freshWs();
    const wsB = freshWs();
    await setPromptOverride(wsA, 'shared-slug', 'engineer', 'A-body');
    await setPromptOverride(wsB, 'shared-slug', 'engineer', 'B-body');
    // Same harness slug, same role, different workspace → independent overrides.
    expect(await getPromptOverride(wsA, 'shared-slug', 'engineer')).toBe('A-body');
    expect(await getPromptOverride(wsB, 'shared-slug', 'engineer')).toBe('B-body');
    // Different harness in the same workspace → no leak.
    expect(await getPromptOverride(wsA, 'other-slug', 'engineer')).toBeNull();
    // Different role in the same (workspace, harness) → no leak.
    expect(await getPromptOverride(wsA, 'shared-slug', 'reviewer')).toBeNull();
  });

  it('deletePromptOverride returns true when a row existed, false otherwise', async () => {
    const ws = freshWs();
    await setPromptOverride(ws, 'harness-c', 'engineer', 'body');
    expect(await deletePromptOverride(ws, 'harness-c', 'engineer')).toBe(true);
    expect(await getPromptOverride(ws, 'harness-c', 'engineer')).toBeNull();
    // Second delete: nothing to remove.
    expect(await deletePromptOverride(ws, 'harness-c', 'engineer')).toBe(false);
  });

  it('clearAllPromptOverrides removes every role for the harness and returns the count', async () => {
    const ws = freshWs();
    await setPromptOverride(ws, 'harness-d', 'engineer', 'e');
    await setPromptOverride(ws, 'harness-d', 'mug', 'q');
    await setPromptOverride(ws, 'harness-d', 'reviewer', 'r');
    // A sibling harness in the same workspace must NOT be cleared.
    await setPromptOverride(ws, 'harness-d-sibling', 'engineer', 'keep');

    expect(await clearAllPromptOverrides(ws, 'harness-d')).toBe(3);
    expect(await listPromptOverrides(ws, 'harness-d')).toHaveLength(0);
    expect(await getPromptOverride(ws, 'harness-d-sibling', 'engineer')).toBe('keep');
    // Clearing an empty harness returns 0.
    expect(await clearAllPromptOverrides(ws, 'harness-d')).toBe(0);
  });

  it('listPromptOverrides returns all roles ordered by role with updatedAt as a number', async () => {
    const ws = freshWs();
    // Insert out of alphabetical order; the store ORDER BY role should sort them.
    await setPromptOverride(ws, 'harness-e', 'reviewer', 'r-body');
    await setPromptOverride(ws, 'harness-e', 'engineer', 'e-body');
    await setPromptOverride(ws, 'harness-e', 'mug', 'q-body');

    const rows = await listPromptOverrides(ws, 'harness-e');
    expect(rows.map((r) => r.role)).toEqual(['engineer', 'mug', 'reviewer']);
    const eng = rows.find((r) => r.role === 'engineer')!;
    expect(eng.promptMd).toBe('e-body');
    expect(typeof eng.updatedAt).toBe('number');
    expect(Number.isFinite(eng.updatedAt)).toBe(true);
    expect(eng.updatedAt).toBeGreaterThan(0);
  });
});
