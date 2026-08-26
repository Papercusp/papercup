/**
 * D-010 recurrence coverage for Personal Vault import admission and cleanup.
 *
 * These tests execute the draft migration plus the production helpers against
 * a real Postgres database and a private temporary filesystem root. They prove
 * the aggregate guarantees that SQL-string mocks cannot: advisory-lock
 * serialization, owner/workspace retained-capacity accounting, and crash
 * orphan cleanup without deleting live archives.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { _resetPapercuspRootForTests } from '../papercusp-root';
import {
  MAX_PERSONAL_VAULT_IMPORT_BYTES,
  MAX_PERSONAL_VAULT_OWNER_RETAINED_BYTES,
  MAX_PERSONAL_VAULT_WORKSPACE_RETAINED_BYTES,
  cleanupOrphanedPersonalVaultImportUploads,
  personalVaultImportStorageDir,
  reservePersonalVaultImportUpload,
} from './import-jobs';

const MIGRATION = fileURLToPath(new URL(
  '../../../../libs/papercusp/libs/db/sql/983-personal-vault-import-jobs.sql.DRAFT',
  import.meta.url,
));
const WS = `personal-vault-import-jobs-${process.pid}`;
const RUN = `${process.pid}-${Date.now()}`;

let org: OrgTestDb;
let userId: string;
let otherUserId: string;
let sandbox: string;
let previousPapercuspHome: string | undefined;

beforeAll(async () => {
  previousPapercuspHome = process.env.PAPERCUSP_HOME;
  sandbox = await mkdtemp(join(tmpdir(), 'personal-vault-import-jobs-'));
  process.env.PAPERCUSP_HOME = sandbox;
  _resetPapercuspRootForTests();

  org = await createOrgTestDb();
  await org.adminSql.unsafe(readFileSync(MIGRATION, 'utf8'));
  const users = await org.adminSql<Array<{ id: string }>>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES
      (${`pv-import-owner-${RUN}`}, 'Personal Vault Import Owner'),
      (${`pv-import-other-${RUN}`}, 'Personal Vault Import Other')
    RETURNING id`;
  [userId, otherUserId] = users.map((row) => row.id);
});

beforeEach(async () => {
  await org.adminSql`
    DELETE FROM harness_shared.personal_vault_import_uploads
     WHERE workspace_id = ${WS}`;
  await org.adminSql`
    DELETE FROM harness_shared.personal_vault_import_jobs
     WHERE workspace_id = ${WS}`;
  await org.adminSql`
    DELETE FROM harness_shared.users
     WHERE username LIKE ${`pv-import-filler-${RUN}-%`}`;
  await rm(personalVaultImportStorageDir(WS), { recursive: true, force: true });
});

afterAll(async () => {
  if (org) {
    await org.adminSql`
      DELETE FROM harness_shared.users
       WHERE username IN (${`pv-import-owner-${RUN}`}, ${`pv-import-other-${RUN}`})
          OR username LIKE ${`pv-import-filler-${RUN}-%`}`.catch(() => undefined);
    await org.cleanup();
  }
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousPapercuspHome;
  _resetPapercuspRootForTests();
});

describe('Personal Vault import aggregate admission (D-010)', () => {
  it('reserves the worst-case size for unknown bodies and atomically rejects concurrent overbooking', async () => {
    const outcomes = await Promise.allSettled([
      reservePersonalVaultImportUpload(org.adminSql, {
        workspaceId: WS,
        userId,
        filename: 'first.zip',
      }),
      reservePersonalVaultImportUpload(org.adminSql, {
        workspaceId: WS,
        userId,
        filename: 'second.zip',
      }),
      reservePersonalVaultImportUpload(org.adminSql, {
        workspaceId: WS,
        userId,
        filename: 'racing-third.zip',
      }),
    ]);

    const accepted = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof reservePersonalVaultImportUpload>>> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(accepted).toHaveLength(2);
    expect(accepted.every((outcome) =>
      outcome.value.declaredSizeBytes === null &&
      outcome.value.reservedBytes === MAX_PERSONAL_VAULT_IMPORT_BYTES
    )).toBe(true);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      message: 'personal_vault_import_owner_storage_limit',
    });

    const aggregate = await org.adminSql<Array<{ jobs: number; bytes: number }>>`
      SELECT count(*)::int AS jobs, sum(reserved_bytes)::bigint AS bytes
        FROM harness_shared.personal_vault_import_uploads
       WHERE workspace_id = ${WS} AND user_id = ${userId}::uuid`;
    expect(aggregate).toEqual([{
      jobs: 2,
      bytes: MAX_PERSONAL_VAULT_OWNER_RETAINED_BYTES,
    }]);
  });

  it('rejects a new owner when retained archives have filled the workspace ceiling', async () => {
    const fillerUsers = await org.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.users (username, display_name)
      SELECT ${`pv-import-filler-${RUN}-`} || n::text, 'Personal Vault Filler'
        FROM generate_series(1, 16) AS n
      RETURNING id`;
    for (const [index, filler] of fillerUsers.entries()) {
      const idempotencyKey = (index + 1).toString(16).padStart(64, '0');
      await org.adminSql`
        INSERT INTO harness_shared.personal_vault_import_jobs
          (workspace_id, user_id, filename, storage_path, content_sha256,
           idempotency_key, size_bytes)
        VALUES (${WS}, ${filler.id}::uuid, ${`archive-${index}.zip`},
                ${join(personalVaultImportStorageDir(WS), `${randomUUID()}.archive`)},
                ${'a'.repeat(64)}, ${idempotencyKey},
                ${MAX_PERSONAL_VAULT_IMPORT_BYTES})`;
    }

    const usage = await org.adminSql<Array<{ bytes: number }>>`
      SELECT sum(size_bytes)::bigint AS bytes
        FROM harness_shared.personal_vault_import_jobs
       WHERE workspace_id = ${WS}`;
    expect(usage).toEqual([{ bytes: MAX_PERSONAL_VAULT_WORKSPACE_RETAINED_BYTES }]);
    await expect(reservePersonalVaultImportUpload(org.adminSql, {
      workspaceId: WS,
      userId: otherUserId,
      filename: 'one-byte-too-many.zip',
      declaredSizeBytes: 1,
    })).rejects.toThrow('personal_vault_import_workspace_storage_limit');
  });
});

describe('Personal Vault import orphan recovery (D-010)', () => {
  it('cleans expired and unreferenced ciphertext idempotently while preserving live uploads and jobs', async () => {
    const root = personalVaultImportStorageDir(WS);
    await mkdir(root, { recursive: true });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    const makeOldFile = async (path: string) => {
      await writeFile(path, 'encrypted-test-ciphertext');
      await utimes(path, old, old);
    };

    const liveUpload = await reservePersonalVaultImportUpload(org.adminSql, {
      workspaceId: WS,
      userId,
      filename: 'live-upload.zip',
      declaredSizeBytes: 1,
    });
    const liveUploadArchive = liveUpload.storagePath.replace(/\.partial$/i, '.archive');
    await makeOldFile(liveUpload.storagePath);
    await makeOldFile(liveUploadArchive);

    const expiredUpload = await reservePersonalVaultImportUpload(org.adminSql, {
      workspaceId: WS,
      userId,
      filename: 'expired-upload.zip',
      declaredSizeBytes: 1,
    });
    const expiredUploadArchive = expiredUpload.storagePath.replace(/\.partial$/i, '.archive');
    await makeOldFile(expiredUpload.storagePath);
    await makeOldFile(expiredUploadArchive);
    await org.adminSql`
      UPDATE harness_shared.personal_vault_import_uploads
         SET expires_at = now() - interval '1 second'
       WHERE workspace_id = ${WS} AND id = ${expiredUpload.id}::uuid`;

    const liveJobArchive = join(root, `${randomUUID()}.archive`);
    await makeOldFile(liveJobArchive);
    await org.adminSql`
      INSERT INTO harness_shared.personal_vault_import_jobs
        (workspace_id, user_id, filename, storage_path, content_sha256,
         idempotency_key, size_bytes)
      VALUES (${WS}, ${userId}::uuid, 'live-job.zip', ${liveJobArchive},
              ${'b'.repeat(64)}, ${'c'.repeat(64)}, 1)`;

    const orphanPartial = join(root, `${randomUUID()}.partial`);
    const orphanArchive = join(root, `${randomUUID()}.archive`);
    await makeOldFile(orphanPartial);
    await makeOldFile(orphanArchive);

    await expect(cleanupOrphanedPersonalVaultImportUploads(org.adminSql, WS)).resolves.toBe(3);
    expect(existsSync(expiredUpload.storagePath)).toBe(false);
    expect(existsSync(expiredUploadArchive)).toBe(false);
    expect(existsSync(orphanPartial)).toBe(false);
    expect(existsSync(orphanArchive)).toBe(false);
    expect(existsSync(liveUpload.storagePath)).toBe(true);
    expect(existsSync(liveUploadArchive)).toBe(true);
    expect(existsSync(liveJobArchive)).toBe(true);

    await expect(cleanupOrphanedPersonalVaultImportUploads(org.adminSql, WS)).resolves.toBe(0);
    expect(existsSync(liveUpload.storagePath)).toBe(true);
    expect(existsSync(liveJobArchive)).toBe(true);
  });
});
