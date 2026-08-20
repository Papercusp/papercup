/**
 * WI-40001 — durable peer identity/lifecycle on substrate merge cursors.
 *
 * Exercises the real additive migration and the real PG store against a fresh
 * Postgres database. Historical rows must remain unknown/alertable; explicit
 * lifecycle writes must never rewind or re-scope an existing cursor.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { createPgMergeCursorStore } from '../pg-merge-cursor-store';

function migrationPath(fileName: string): string {
  const armed = fileURLToPath(new URL(`../../../../../../libs/papercusp/libs/db/sql/${fileName}`, import.meta.url));
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration not found at ${armed} or ${draft}`);
}

describe('migration 854 + pg merge cursor peer lifecycle', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('merge-cursor-peer-lifecycle');
    sql = db.sql;
    await applyMigrationForTest(sql, migrationPath('493-substrate-merge-cursor.sql'));
    await applyMigrationForTest(sql, migrationPath('685-substrate-merge-cursor-apply-binding.sql'));
    await sql`
      INSERT INTO harness_shared.substrate_merge_cursor
        (workspace_id, harness_slug, log_keyhex, position, apply_binding)
      VALUES ('w', 'h', 'historical-log', 41, 'original-binding')
    `;
    await applyMigrationForTest(sql, migrationPath('854-substrate-merge-cursor-peer-lifecycle.sql'));
    // The runner can retry after a crash. The additive migration must be safe
    // to apply twice, including its named CHECK constraints.
    await applyMigrationForTest(sql, migrationPath('854-substrate-merge-cursor-peer-lifecycle.sql'));
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('keeps historical rows unknown rather than inferring retirement', async () => {
    const store = createPgMergeCursorStore('w', 'h', () => sql);
    const lifecycle = await store.peerLifecycle!.load();

    expect(lifecycle.get('historical-log')).toEqual({
      logKeyHex: 'historical-log',
      devicePubkey: null,
      state: 'unknown',
      updatedAt: null,
    });
  });

  it('persists explicit lifecycle without rewinding or re-scoping an existing cursor', async () => {
    const store = createPgMergeCursorStore('w', 'h', () => sql);
    await store.peerLifecycle!.upsert(
      [{ logKeyHex: 'historical-log', devicePubkey: 'device-base64', state: 'active' }],
      'different-binding',
    );

    const [row] = await sql<
      {
        position: number;
        apply_binding: string | null;
        peer_device_pubkey: string | null;
        peer_lifecycle_state: string;
      }[]
    >`
      SELECT position, apply_binding, peer_device_pubkey, peer_lifecycle_state
      FROM harness_shared.substrate_merge_cursor
      WHERE workspace_id = 'w' AND harness_slug = 'h' AND log_keyhex = 'historical-log'
    `;
    expect(row).toEqual({
      position: 41,
      apply_binding: 'original-binding',
      peer_device_pubkey: 'device-base64',
      peer_lifecycle_state: 'active',
    });
  });

  it('creates an admission-before-fold row at safe position zero and preserves lifecycle on save', async () => {
    const store = createPgMergeCursorStore('w', 'h', () => sql);
    await store.peerLifecycle!.upsert(
      [{ logKeyHex: 'new-log', devicePubkey: 'new-device-base64', state: 'active' }],
      'home-binding',
    );
    await store.save(new Map([['new-log', 17]]), 'home-binding');

    const [row] = await sql<
      {
        position: number;
        apply_binding: string | null;
        peer_device_pubkey: string | null;
        peer_lifecycle_state: string;
      }[]
    >`
      SELECT position, apply_binding, peer_device_pubkey, peer_lifecycle_state
      FROM harness_shared.substrate_merge_cursor
      WHERE workspace_id = 'w' AND harness_slug = 'h' AND log_keyhex = 'new-log'
    `;
    expect(row).toEqual({
      position: 17,
      apply_binding: 'home-binding',
      peer_device_pubkey: 'new-device-base64',
      peer_lifecycle_state: 'active',
    });

    await store.peerLifecycle!.upsert(
      [{ logKeyHex: 'new-log', devicePubkey: 'new-device-base64', state: 'retired' }],
      'ignored-on-conflict',
    );
    expect((await store.peerLifecycle!.load()).get('new-log')?.state).toBe('retired');
  });

  it('rejects known lifecycle state without durable identity evidence', async () => {
    await expect(
      sql`
        INSERT INTO harness_shared.substrate_merge_cursor
          (workspace_id, harness_slug, log_keyhex, position, peer_lifecycle_state)
        VALUES ('w', 'h', 'invalid-known-log', 0, 'retired')
      `,
    ).rejects.toThrow(/peer_lifecycle_identity_check/);
  });
});
