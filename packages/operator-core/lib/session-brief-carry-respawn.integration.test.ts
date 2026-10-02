import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  clearPendingCarryRespawn,
  consumePendingCarryRespawn,
  PENDING_CARRY_RESPAWN_TTL_MS,
  restorePendingCarryRespawn,
  savePendingCarryRespawn,
} from './session-brief';

const here = dirname(fileURLToPath(import.meta.url));
const sessionBriefMigration = resolve(
  here,
  '../../../libs/papercusp/libs/db/sql/322-session-briefs-ei1742.sql',
);
// The live migration is still a draft while its activation safety is reviewed.
// Apply its candidate DDL explicitly to this throwaway database so the test covers
// both the missing-column failure and the real migrated write/consume/restore path.
const pendingCarryMigration = resolve(
  here,
  '../../../libs/papercusp/libs/db/sql/1340-session-brief-pending-carry-respawn.sql',
);
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-carry-respawn-${RUN}`;
const WORKSPACE = `carry-respawn-${RUN}`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('session-brief-carry-respawn');
  await applyMigrationForTest(db.sql, sessionBriefMigration);
}, 90_000);

afterAll(async () => db?.cleanup());

describe('pending carry-respawn on real Postgres', () => {
  it('proves the migration requirement and persists a one-shot slot with nonce-safe restore and clear', async () => {
    const nowMs = Date.now();
    const payload = {
      firstPrompt: 'Continue the verified active task.',
      systemPromptAddendum: 'Persisted carry document for the successor.',
    };

    await expect(savePendingCarryRespawn(
      { ownerId: OWNER, workspaceId: WORKSPACE },
      payload,
      { sql: db.sql, nowMs, nonce: 'before-migration' },
    )).rejects.toThrow(/pending_carry_respawn/);

    await applyMigrationForTest(db.sql, pendingCarryMigration);
    const original = await savePendingCarryRespawn(
      { ownerId: OWNER, workspaceId: WORKSPACE },
      payload,
      { sql: db.sql, nowMs, nonce: 'carry-nonce-1' },
    );
    expect(original).toMatchObject({
      nonce: 'carry-nonce-1',
      createdAtMs: nowMs,
      expiresAtMs: nowMs + PENDING_CARRY_RESPAWN_TTL_MS,
      ...payload,
    });

    await expect(consumePendingCarryRespawn(OWNER, { sql: db.sql, nowMs: nowMs + 1 }))
      .resolves.toEqual(original);
    await expect(consumePendingCarryRespawn(OWNER, { sql: db.sql, nowMs: nowMs + 2 }))
      .resolves.toBeNull();

    expect(await restorePendingCarryRespawn(
      OWNER,
      WORKSPACE,
      original!,
      { sql: db.sql, nowMs: nowMs + 3 },
    )).toBe(true);

    const newer = await savePendingCarryRespawn(
      { ownerId: OWNER, workspaceId: WORKSPACE },
      { ...payload, firstPrompt: 'Continue the newer active task.' },
      { sql: db.sql, nowMs: nowMs + 4, nonce: 'carry-nonce-2' },
    );
    expect(newer?.nonce).toBe('carry-nonce-2');
    expect(await restorePendingCarryRespawn(
      OWNER,
      WORKSPACE,
      original!,
      { sql: db.sql, nowMs: nowMs + 5 },
    )).toBe(false);
    await expect(clearPendingCarryRespawn(OWNER, 'carry-nonce-1', { sql: db.sql }))
      .resolves.toBe(false);

    const persisted = await db.sql`
      SELECT pending_carry_respawn
        FROM harness_shared.session_briefs
       WHERE owner_id = ${OWNER}
    `;
    expect(persisted[0]?.pending_carry_respawn).toMatchObject({ nonce: 'carry-nonce-2' });
    await expect(clearPendingCarryRespawn(OWNER, 'carry-nonce-2', { sql: db.sql }))
      .resolves.toBe(true);
    const cleared = await db.sql`
      SELECT pending_carry_respawn
        FROM harness_shared.session_briefs
       WHERE owner_id = ${OWNER}
    `;
    expect(cleared[0]?.pending_carry_respawn).toBeNull();
  }, 30_000);
});
