/**
 * hive-store.integration.test.ts — the harness_shared.hives entity table
 * (migration 184, shared-hive-federation-2026-06-08 P-002) against real migrated
 * PG. Covers the store's own contract: get-or-create idempotency (identity is
 * never clobbered), slug- AND pubkey-resolution, workspace-scoped list, metadata
 * edit, delete, the 32-byte pubkey guard, and RLS workspace isolation.
 *
 * The cross-module keypair->store->topic seam is covered separately
 * (su-30045's joint Phase-0 integration test); this file is the store in isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';
import {
  deleteHive,
  getHive,
  getHiveByPubkey,
  getHiveBySlug,
  insertHiveIfAbsent,
  listHives,
  updateHiveMeta,
} from './hive-store';

/** A deterministic raw-32 base64 Ed25519-shaped pubkey for tests. */
const pk = (fill: number): string => Buffer.alloc(32, fill).toString('base64');

describe('hive-store (real PG, migration 184)', () => {
  let db: OrgTestDb;
  let sql: Sql;
  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql; // RLS-bypass for the bulk CRUD assertions
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });

  it('get-or-creates idempotently — identity + metadata never clobbered', async () => {
    const ws = 'ws-a';
    const first = await insertHiveIfAbsent(
      { workspaceId: ws, homeSlug: 'alpha', pubkeyBase64: pk(1), keychainId: 'hive:ws-a:alpha', title: 'Alpha', description: 'first' },
      sql,
    );
    expect(first.created).toBe(true);
    expect(first.record.pubkeyBase64).toBe(pk(1));
    expect(first.record.keychainId).toBe('hive:ws-a:alpha');
    expect(first.record.title).toBe('Alpha');

    // A second ensure with a DIFFERENT pubkey/title must NOT rotate the identity
    // or overwrite metadata — it returns the existing row unchanged.
    const second = await insertHiveIfAbsent(
      { workspaceId: ws, homeSlug: 'alpha', pubkeyBase64: pk(2), keychainId: 'hive:ws-a:alpha', title: 'CLOBBER' },
      sql,
    );
    expect(second.created).toBe(false);
    expect(second.record.pubkeyBase64).toBe(pk(1)); // unchanged
    expect(second.record.title).toBe('Alpha'); // unchanged
  });

  it('resolves by home-slug AND by pubkey', async () => {
    const ws = 'ws-b';
    await insertHiveIfAbsent({ workspaceId: ws, homeSlug: 'beta', pubkeyBase64: pk(3), keychainId: 'k' }, sql);

    const bySlug = await getHiveBySlug(ws, 'beta', sql);
    expect(bySlug?.pubkeyBase64).toBe(pk(3));

    const byKey = await getHiveByPubkey(ws, pk(3), sql);
    expect(byKey?.homeSlug).toBe('beta');

    // getHive accepts either identifier
    expect((await getHive(ws, 'beta', sql))?.homeSlug).toBe('beta');
    expect((await getHive(ws, pk(3), sql))?.homeSlug).toBe('beta');
    // unknown id -> null (not a throw)
    expect(await getHive(ws, 'nope', sql)).toBeNull();
    expect(await getHiveByPubkey(ws, pk(9), sql)).toBeNull();
  });

  it('lists workspace hives newest-first, scoped to the workspace', async () => {
    const ws = 'ws-c';
    await insertHiveIfAbsent({ workspaceId: ws, homeSlug: 'one', pubkeyBase64: pk(4), keychainId: 'k' }, sql);
    await new Promise((r) => setTimeout(r, 2)); // ensure distinct created_at
    await insertHiveIfAbsent({ workspaceId: ws, homeSlug: 'two', pubkeyBase64: pk(5), keychainId: 'k' }, sql);
    // a hive in another workspace must NOT appear
    await insertHiveIfAbsent({ workspaceId: 'ws-c-other', homeSlug: 'three', pubkeyBase64: pk(6), keychainId: 'k' }, sql);

    const hives = await listHives(ws, sql);
    expect(hives.map((h) => h.homeSlug)).toEqual(['two', 'one']); // newest first
  });

  it('edits metadata without touching identity', async () => {
    const ws = 'ws-d';
    await insertHiveIfAbsent({ workspaceId: ws, homeSlug: 'delta', pubkeyBase64: pk(7), keychainId: 'k' }, sql);
    const updated = await updateHiveMeta(ws, 'delta', { title: 'Delta!', description: 'edited' }, sql);
    expect(updated?.title).toBe('Delta!');
    expect(updated?.description).toBe('edited');
    expect(updated?.pubkeyBase64).toBe(pk(7)); // identity untouched
    expect(await updateHiveMeta(ws, 'missing', { title: 'x' }, sql)).toBeNull();
  });

  it('deletes (idempotent)', async () => {
    const ws = 'ws-e';
    await insertHiveIfAbsent({ workspaceId: ws, homeSlug: 'echo', pubkeyBase64: pk(8), keychainId: 'k' }, sql);
    expect(await deleteHive(ws, 'echo', sql)).toBe(true);
    expect(await getHiveBySlug(ws, 'echo', sql)).toBeNull();
    expect(await deleteHive(ws, 'echo', sql)).toBe(false); // already gone
  });

  it('rejects a non-32-byte pubkey', async () => {
    await expect(
      insertHiveIfAbsent(
        { workspaceId: 'ws-f', homeSlug: 'bad', pubkeyBase64: Buffer.alloc(16, 1).toString('base64'), keychainId: 'k' },
        sql,
      ),
    ).rejects.toThrow(/32 raw bytes/);
  });

  it('RLS isolates a hive to its workspace (RLS-subject connection)', async () => {
    const key = pk(11);
    // Insert under ws-rls-a via the RLS-SUBJECT app role.
    await db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${'ws-rls-a'}, true)`;
      const { created } = await insertHiveIfAbsent(
        { workspaceId: 'ws-rls-a', homeSlug: 'secret', pubkeyBase64: key, keychainId: 'k' },
        tx as unknown as Sql,
      );
      expect(created).toBe(true);
    });
    // A ws-rls-b-scoped connection cannot see ws-rls-a's hive (by slug or pubkey).
    await db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${'ws-rls-b'}, true)`;
      expect(await getHiveBySlug('ws-rls-a', 'secret', tx as unknown as Sql)).toBeNull();
      expect(await getHiveByPubkey('ws-rls-a', key, tx as unknown as Sql)).toBeNull();
    });
    // Its own workspace can.
    await db.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${'ws-rls-a'}, true)`;
      expect((await getHiveBySlug('ws-rls-a', 'secret', tx as unknown as Sql))?.homeSlug).toBe('secret');
    });
  });
});
