/**
 * user-preferences.integration.test.ts — the per-user preference override store
 * against REAL Postgres (testcontainer). Validates the jsonb-merge upsert (the
 * `payload || EXCLUDED.payload` ON-CONFLICT), per-user scoping (PK user_id),
 * single-key clear (`payload - key`), and the null-empty contract against the
 * full migrated baseline schema.
 *
 * The store routes every op through `getOrgPg().sql` (admin role; this table is
 * NOT RLS-enabled and is scoped by the explicit user_id PK), so we mock getOrgPg
 * to the fixture's admin client. `user_id` is a uuid that FK-references
 * harness_shared.users(id) ON DELETE CASCADE, so each test first seeds a real
 * user row (via seedUser) → cases are isolated by distinct user ids.
 *
 * mergeUserOverWorkspace is pure (no PG) and lives in the unit tier; this file
 * exercises only the durable SQL paths.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as any, ws: 'ws-default' }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
// workspace-data-isolation-leaks F / owner D-001: user prefs are now per
// (user_id, workspace_id) — control the active workspace per case.
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => h.ws };
});

const { loadUserPreferences, saveUserPreferences, clearUserPreferenceKey } =
  await import('./user-preferences');
const { createOrgTestDb } = await import('../test/_org-test-db');

/** Seed a real users row (FK target of user_preferences.user_id) and return its id. */
async function seedUser(): Promise<string> {
  const id = randomUUID();
  await h.sql`
    INSERT INTO harness_shared.users (id, username, display_name)
    VALUES (${id}, ${`u_${id.slice(0, 8)}`}, ${'Test User'})
  `;
  return id;
}

describe('user_preferences store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('loadUserPreferences returns {} for a null user and for an unset user', async () => {
    expect(await loadUserPreferences(null)).toEqual({});
    expect(await loadUserPreferences(randomUUID())).toEqual({});
  });

  it('saveUserPreferences inserts then reads back the payload', async () => {
    const uid = await seedUser();
    const out = await saveUserPreferences(uid, { agentLanguage: 'en', voiceMaxSpokenWords: 40 });
    expect(out).toMatchObject({ agentLanguage: 'en', voiceMaxSpokenWords: 40 });
    expect(await loadUserPreferences(uid)).toMatchObject({
      agentLanguage: 'en',
      voiceMaxSpokenWords: 40,
    });
  });

  it('ON CONFLICT merges (jsonb ||): new keys add, existing keys overwrite, untouched keys persist', async () => {
    const uid = await seedUser();
    await saveUserPreferences(uid, { agentLanguage: 'en', speakSuggestions: true });
    // Second save: overwrite one key, add another, leave speakSuggestions alone.
    const merged = await saveUserPreferences(uid, { agentLanguage: 'fr', wakeWordKeyword: 'hey' });
    expect(merged).toMatchObject({
      agentLanguage: 'fr', // overwritten
      wakeWordKeyword: 'hey', // added
      speakSuggestions: true, // preserved from the first write
    });
    // Confirms the merge happened in PG, not just in the returned value.
    expect(await loadUserPreferences(uid)).toMatchObject({
      agentLanguage: 'fr',
      wakeWordKeyword: 'hey',
      speakSuggestions: true,
    });
  });

  it('is scoped per user — one user\'s prefs never leak to another', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await saveUserPreferences(a, { agentLanguage: 'en' });
    await saveUserPreferences(b, { agentLanguage: 'de' });
    expect((await loadUserPreferences(a)).agentLanguage).toBe('en');
    expect((await loadUserPreferences(b)).agentLanguage).toBe('de');
  });

  it('is scoped per WORKSPACE — the SAME user is isolated across workspaces (owner D-001)', async () => {
    const uid = await seedUser();
    h.ws = 'ws-a';
    await saveUserPreferences(uid, { agentLanguage: 'en' });
    h.ws = 'ws-b';
    await saveUserPreferences(uid, { agentLanguage: 'de' });
    // Each workspace sees only its own override; no cross-workspace bleed.
    h.ws = 'ws-a';
    expect((await loadUserPreferences(uid)).agentLanguage).toBe('en');
    h.ws = 'ws-b';
    expect((await loadUserPreferences(uid)).agentLanguage).toBe('de');
    h.ws = 'ws-default';
  });

  it('clearUserPreferenceKey removes one key and leaves the rest', async () => {
    const uid = await seedUser();
    await saveUserPreferences(uid, { agentLanguage: 'en', wakeWordKeyword: 'hey', speakSuggestions: true });
    await clearUserPreferenceKey(uid, 'wakeWordKeyword');
    const after = await loadUserPreferences(uid);
    expect(after).not.toHaveProperty('wakeWordKeyword');
    expect(after).toMatchObject({ agentLanguage: 'en', speakSuggestions: true });
  });

  it('clearUserPreferenceKey on an unset user is a no-op (no row, no throw)', async () => {
    const uid = randomUUID();
    await expect(clearUserPreferenceKey(uid, 'agentLanguage')).resolves.toBeUndefined();
    expect(await loadUserPreferences(uid)).toEqual({});
  });

  it('preserves nested-object and array values through the round-trip', async () => {
    const uid = await seedUser();
    const payload = { nested: { a: 1, b: [1, 2, 3] }, flag: false };
    await saveUserPreferences(uid, payload);
    expect(await loadUserPreferences(uid)).toEqual(payload);
  });
});
