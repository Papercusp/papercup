/**
 * notes.integration.test.ts — the minimal notes app's PG-backed data access
 * (owner-ask-batch-2026-07-06 P-004, WI-3265) against a real migrated
 * Postgres: migration 527 applies, CRUD round-trips, search filters by
 * title/body, and workspace scoping isolates rows between workspaces.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, ws: 'ws-notes-a' }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

import { createNote, deleteNote, listNotes, updateNote } from './notes';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('notes CRUD (migration 527)', () => {
  it('creates a note and lists it back, newest-updated first', async () => {
    h.ws = 'ws-notes-a';
    const a = await createNote({ title: 'Groceries', body: 'milk, eggs' });
    expect(a.id).toBeTruthy();
    expect(a.title).toBe('Groceries');
    expect(a.body).toBe('milk, eggs');

    const b = await createNote({ title: 'Ideas', body: 'build a notes app' });

    const rows = await listNotes();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // b was created after a → newest-updated-first puts it earlier.
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it('defaults title/body to empty strings when omitted', async () => {
    h.ws = 'ws-notes-a';
    const note = await createNote({});
    expect(note.title).toBe('');
    expect(note.body).toBe('');
  });

  it('updates a note and bumps updated_at', async () => {
    h.ws = 'ws-notes-a';
    const note = await createNote({ title: 'Draft', body: 'v1' });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateNote(note.id, { title: 'Final', body: 'v2' });
    expect(updated?.title).toBe('Final');
    expect(updated?.body).toBe('v2');
    expect(Date.parse(updated!.updated_at)).toBeGreaterThanOrEqual(Date.parse(note.updated_at));
  });

  it('a partial update leaves the other field untouched', async () => {
    h.ws = 'ws-notes-a';
    const note = await createNote({ title: 'Keep title', body: 'old body' });
    const updated = await updateNote(note.id, { body: 'new body' });
    expect(updated?.title).toBe('Keep title');
    expect(updated?.body).toBe('new body');
  });

  it('updateNote/deleteNote on a nonexistent id return null/false', async () => {
    h.ws = 'ws-notes-a';
    expect(await updateNote('00000000-0000-0000-0000-000000000000', { title: 'x' })).toBeNull();
    expect(await deleteNote('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('deletes a note', async () => {
    h.ws = 'ws-notes-a';
    const note = await createNote({ title: 'Temp', body: 'delete me' });
    expect(await deleteNote(note.id)).toBe(true);
    const rows = await listNotes();
    expect(rows.map((r) => r.id)).not.toContain(note.id);
  });

  it('search filters by a case-insensitive substring over title OR body', async () => {
    h.ws = 'ws-notes-search';
    await createNote({ title: 'Recipe: pasta', body: 'boil water, add salt' });
    await createNote({ title: 'Shopping list', body: 'PASTA sauce, bread' });
    await createNote({ title: 'Unrelated', body: 'nothing matching' });

    const byTitle = await listNotes('recipe');
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0].title).toBe('Recipe: pasta');

    const byBody = await listNotes('pasta');
    expect(byBody).toHaveLength(2);

    const none = await listNotes('xyzzy-nomatch');
    expect(none).toHaveLength(0);
  });

  it('scopes notes to the active workspace — another workspace never sees them', async () => {
    h.ws = 'ws-notes-iso-1';
    await createNote({ title: 'Isolated', body: 'workspace 1 only' });

    h.ws = 'ws-notes-iso-2';
    const rows = await listNotes();
    expect(rows.map((r) => r.title)).not.toContain('Isolated');
  });
});
