import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type postgres from 'postgres';
import { papercuspPathForWorkspace } from '../papercusp-root';
import {
  streamPersonalArchiveFile,
  type PersonalArchiveCheckpoint,
} from './archive-import';
import {
  PersonalArchiveEncryptedWriter,
  verifyEncryptedPersonalArchiveDigest,
  type PersonalArchiveEncryptionOptions,
} from './archive-encryption';
import {
  normalizePersonalProviderAccountId,
  normalizePersonalSourceId,
  upsertPersonalDocuments,
} from './store';
import type { PersonalDocumentInput } from './types';

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_WARNINGS = 100;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_SECONDS = 600;
const MAX_BATCH_SIZE = 1_000;
const MAX_LEASE_SECONDS = 3_600;
export const MAX_PERSONAL_VAULT_IMPORT_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_PERSONAL_VAULT_OWNER_RETAINED_BYTES = 32 * 1024 * 1024 * 1024;
export const MAX_PERSONAL_VAULT_WORKSPACE_RETAINED_BYTES = 256 * 1024 * 1024 * 1024;
export const MAX_PERSONAL_VAULT_OWNER_STORED_JOBS = 8;
export const MAX_PERSONAL_VAULT_WORKSPACE_STORED_JOBS = 64;
const PERSONAL_VAULT_UPLOAD_LEASE_SECONDS = 24 * 60 * 60;
const PERSONAL_VAULT_UPLOAD_PROGRESS_BYTES = 64 * 1024 * 1024;
const PERSONAL_VAULT_ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;
const IMPORT_ARCHIVE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:partial|archive)$/i;

export type PersonalVaultImportStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PersonalVaultImportJob {
  id: string;
  workspaceId: string;
  userId: string;
  sourceId: string | null;
  providerAccountId: string | null;
  filename: string;
  storagePath: string | null;
  contentType: string | null;
  contentSha256: string;
  idempotencyKey: string;
  sizeBytes: number;
  status: PersonalVaultImportStatus;
  bytesProcessed: number;
  entriesProcessed: number;
  documentsSeen: number;
  documentsImported: number;
  checkpoint: PersonalArchiveCheckpoint;
  warnings: string[];
  cancelRequested: boolean;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  retainedUntil: string;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicPersonalVaultImportJob = Pick<
  PersonalVaultImportJob,
  | 'id'
  | 'sourceId'
  | 'providerAccountId'
  | 'filename'
  | 'contentType'
  | 'sizeBytes'
  | 'status'
  | 'bytesProcessed'
  | 'entriesProcessed'
  | 'documentsSeen'
  | 'documentsImported'
  | 'warnings'
  | 'cancelRequested'
  | 'attemptCount'
  | 'maxAttempts'
  | 'nextAttemptAt'
  | 'retainedUntil'
  | 'lastError'
  | 'startedAt'
  | 'completedAt'
  | 'createdAt'
  | 'updatedAt'
>;

export interface StoredPersonalVaultImportArchive {
  storagePath: string;
  contentSha256: string;
  sizeBytes: number;
}

export interface PersonalVaultImportUploadReservation {
  id: string;
  workspaceId: string;
  userId: string;
  filename: string;
  storagePath: string;
  declaredSizeBytes: number | null;
  reservedBytes: number;
  receivedBytes: number;
  expiresAt: string;
}

interface PersonalVaultImportUploadRow {
  id: string;
  workspace_id: string;
  user_id: string;
  filename: string;
  storage_path: string;
  declared_size_bytes: number | string | null;
  reserved_bytes: number | string;
  received_bytes: number | string;
  expires_at: string | Date;
}

interface PersonalVaultImportAdmissionRow {
  workspace_bytes: number | string;
  workspace_jobs: number | string;
  owner_bytes: number | string;
  owner_jobs: number | string;
}

interface PersonalVaultImportJobRow {
  id: string;
  workspace_id: string;
  user_id: string;
  source_id: string | null;
  provider_account_id: string | null;
  filename: string;
  storage_path: string | null;
  content_type: string | null;
  content_sha256: string;
  idempotency_key: string;
  size_bytes: number | string;
  status: PersonalVaultImportStatus;
  bytes_processed: number | string;
  entries_processed: number;
  documents_seen: number | string;
  documents_imported: number | string;
  checkpoint: Partial<PersonalArchiveCheckpoint> | null;
  warnings: unknown;
  cancel_requested: boolean;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | Date;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  retained_until: string | Date;
  last_error: string | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface CreatePersonalVaultImportJobInput {
  workspaceId: string;
  userId: string;
  filename: string;
  storagePath: string;
  contentType?: string | null;
  contentSha256: string;
  sizeBytes: number;
  sourceId?: string | null;
  providerAccountId?: string | null;
  idempotencyKey?: string;
  maxAttempts?: number;
  retainForDays?: number;
}

export interface PersonalVaultImportBatchOptions {
  batchSize?: number;
  leaseSeconds?: number;
  leaseOwner?: string;
  streamArchive?: typeof streamPersonalArchiveFile;
  upsertDocuments?: typeof upsertPersonalDocuments;
  removeArchive?: typeof removePersonalVaultImportArchive;
  verifyArchive?: typeof verifyEncryptedPersonalArchiveDigest;
}

export interface PersonalVaultImportBatchResult {
  claimed: boolean;
  jobId: string | null;
  status: PersonalVaultImportStatus | 'idle';
  documentsSeen: number;
  documentsImported: number;
  warnings: number;
  error: string | null;
}

function asIso(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function finiteInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function checkpoint(value: Partial<PersonalArchiveCheckpoint> | null): PersonalArchiveCheckpoint {
  return {
    entryIndex: finiteInteger(value?.entryIndex, 0, 0, Number.MAX_SAFE_INTEGER),
    recordIndex: finiteInteger(value?.recordIndex, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function warningStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_WARNINGS);
}

function mapJob(row: PersonalVaultImportJobRow): PersonalVaultImportJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    sourceId: row.source_id,
    providerAccountId: row.provider_account_id,
    filename: row.filename,
    storagePath: row.storage_path,
    contentType: row.content_type,
    contentSha256: row.content_sha256,
    idempotencyKey: row.idempotency_key,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    bytesProcessed: Number(row.bytes_processed),
    entriesProcessed: row.entries_processed,
    documentsSeen: Number(row.documents_seen),
    documentsImported: Number(row.documents_imported),
    checkpoint: checkpoint(row.checkpoint),
    warnings: warningStrings(row.warnings),
    cancelRequested: row.cancel_requested,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: asIso(row.next_attempt_at)!,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: asIso(row.lease_expires_at),
    retainedUntil: asIso(row.retained_until)!,
    lastError: row.last_error,
    startedAt: asIso(row.started_at),
    completedAt: asIso(row.completed_at),
    createdAt: asIso(row.created_at)!,
    updatedAt: asIso(row.updated_at)!,
  };
}

function mapUploadReservation(
  row: PersonalVaultImportUploadRow,
): PersonalVaultImportUploadReservation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    filename: row.filename,
    storagePath: row.storage_path,
    declaredSizeBytes: row.declared_size_bytes == null ? null : Number(row.declared_size_bytes),
    reservedBytes: Number(row.reserved_bytes),
    receivedBytes: Number(row.received_bytes),
    expiresAt: asIso(row.expires_at)!,
  };
}

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000);
}

function assertHash(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_RE.test(normalized)) throw new Error(`personal_vault_import_${name}_invalid`);
  return normalized;
}

function normalizedFilename(value: string): string {
  const filename = value.trim();
  if (!filename || filename.length > 1_024 || /[\u0000-\u001f]/.test(filename)) {
    throw new Error('personal_vault_import_filename_invalid');
  }
  return filename;
}

export function personalVaultImportStorageDir(workspaceId: string): string {
  return papercuspPathForWorkspace(workspaceId, 'personal-vault-imports');
}

/** Persist an upload incrementally so multi-GB provider exports never enter memory as one buffer. */
export async function storePersonalVaultImportArchive(
  workspaceId: string,
  body: AsyncIterable<Uint8Array>,
  options: { maxBytes?: number } & PersonalArchiveEncryptionOptions = {},
): Promise<StoredPersonalVaultImportArchive> {
  const maxBytes = finiteInteger(
    options.maxBytes,
    MAX_PERSONAL_VAULT_IMPORT_BYTES,
    1,
    MAX_PERSONAL_VAULT_IMPORT_BYTES,
  );
  const root = personalVaultImportStorageDir(workspaceId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const storagePath = join(root, `${randomUUID()}.archive`);
  const writer = await PersonalArchiveEncryptedWriter.create(workspaceId, storagePath, options);
  let sizeBytes = 0;
  let complete = false;
  try {
    for await (const value of body) {
      const chunk = Buffer.from(value);
      if (!chunk.length) continue;
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) throw new Error('personal_archive_too_large');
      await writer.write(chunk);
    }
    if (sizeBytes === 0) throw new Error('personal_archive_empty');
    const encrypted = await writer.finish();
    complete = true;
    return { storagePath, contentSha256: encrypted.contentSha256, sizeBytes };
  } finally {
    if (!complete) {
      await writer.abort();
      await unlink(storagePath).catch(() => undefined);
    }
  }
}

/** Deliberately omit filesystem paths, leases, and content fingerprints from owner-facing reads. */
export function publicPersonalVaultImportJob(
  job: PersonalVaultImportJob,
): PublicPersonalVaultImportJob {
  return {
    id: job.id,
    sourceId: job.sourceId,
    providerAccountId: job.providerAccountId,
    filename: job.filename,
    contentType: job.contentType,
    sizeBytes: job.sizeBytes,
    status: job.status,
    bytesProcessed: job.bytesProcessed,
    entriesProcessed: job.entriesProcessed,
    documentsSeen: job.documentsSeen,
    documentsImported: job.documentsImported,
    warnings: job.warnings,
    cancelRequested: job.cancelRequested,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt,
    retainedUntil: job.retainedUntil,
    lastError: job.lastError,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function assertSyntacticImportPath(workspaceId: string, storagePath: string): string {
  const root = resolve(personalVaultImportStorageDir(workspaceId));
  const candidate = resolve(storagePath);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('personal_vault_import_storage_path_outside_root');
  }
  return candidate;
}

/** Remove only a regular import path beneath this workspace's private import root. */
export async function removePersonalVaultImportArchive(
  workspaceId: string,
  storagePath: string | null,
): Promise<void> {
  if (!storagePath) return;
  const candidate = assertSyntacticImportPath(workspaceId, storagePath);
  try {
    const [rootReal, candidateReal] = await Promise.all([
      realpath(personalVaultImportStorageDir(workspaceId)),
      realpath(candidate),
    ]);
    const rel = relative(rootReal, candidateReal);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error('personal_vault_import_storage_path_outside_root');
    }
    await unlink(candidateReal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

function defaultIdempotencyKey(input: {
  workspaceId: string;
  userId: string;
  sourceId: string | null;
  providerAccountId: string | null;
  contentSha256: string;
}): string {
  return createHash('sha256').update([
    input.workspaceId,
    input.userId,
    input.sourceId ?? '',
    input.providerAccountId ?? '',
    input.contentSha256,
  ].join('\u001f')).digest('hex');
}

export async function createPersonalVaultImportJob(
  sql: postgres.Sql,
  input: CreatePersonalVaultImportJobInput,
): Promise<PersonalVaultImportJob> {
  const sourceId = normalizePersonalSourceId(input.sourceId);
  const providerAccountId = normalizePersonalProviderAccountId(input.providerAccountId);
  if (sourceId && !providerAccountId) throw new Error('personal_provider_account_id_required_for_source');
  const contentSha256 = assertHash(input.contentSha256, 'content_sha256');
  const idempotencyKey = input.idempotencyKey
    ? assertHash(input.idempotencyKey, 'idempotency_key')
    : defaultIdempotencyKey({
        workspaceId: input.workspaceId,
        userId: input.userId,
        sourceId,
        providerAccountId,
        contentSha256,
      });
  const filename = normalizedFilename(input.filename);
  const storagePath = assertSyntacticImportPath(input.workspaceId, input.storagePath);
  const sizeBytes = finiteInteger(input.sizeBytes, -1, 0, Number.MAX_SAFE_INTEGER);
  if (sizeBytes < 0) throw new Error('personal_vault_import_size_invalid');
  const maxAttempts = finiteInteger(input.maxAttempts, 5, 1, 20);
  const retainForDays = finiteInteger(input.retainForDays, 7, 1, 30);
  const rows = await sql<PersonalVaultImportJobRow[]>`
    INSERT INTO harness_shared.personal_vault_import_jobs
      (workspace_id, user_id, source_id, provider_account_id, filename,
       storage_path, content_type, content_sha256, idempotency_key, size_bytes,
       max_attempts, retained_until)
    VALUES
      (${input.workspaceId}, ${input.userId}::uuid, ${sourceId}::uuid,
       ${providerAccountId}, ${filename}, ${storagePath}, ${input.contentType ?? null},
       ${contentSha256}, ${idempotencyKey}, ${sizeBytes}, ${maxAttempts},
       now() + make_interval(days => ${retainForDays}))
    ON CONFLICT (workspace_id, user_id, idempotency_key) DO UPDATE
      SET updated_at = harness_shared.personal_vault_import_jobs.updated_at
    RETURNING *`;
  return mapJob(rows[0]!);
}

export async function getPersonalVaultImportJob(
  sql: postgres.Sql,
  workspaceId: string,
  userId: string,
  jobId: string,
): Promise<PersonalVaultImportJob | null> {
  const rows = await sql<PersonalVaultImportJobRow[]>`
    SELECT *
      FROM harness_shared.personal_vault_import_jobs
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid
       AND id = ${jobId}::uuid
     LIMIT 1`;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function listPersonalVaultImportJobs(
  sql: postgres.Sql,
  workspaceId: string,
  userId: string,
  limit = 25,
): Promise<PersonalVaultImportJob[]> {
  const boundedLimit = finiteInteger(limit, 25, 1, 100);
  const rows = await sql<PersonalVaultImportJobRow[]>`
    SELECT *
      FROM harness_shared.personal_vault_import_jobs
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid
     ORDER BY created_at DESC
     LIMIT ${boundedLimit}`;
  return rows.map(mapJob);
}

export async function requestPersonalVaultImportCancellation(
  sql: postgres.Sql,
  workspaceId: string,
  userId: string,
  jobId: string,
  removeArchive: typeof removePersonalVaultImportArchive = removePersonalVaultImportArchive,
): Promise<PersonalVaultImportJob | null> {
  const rows = await sql<PersonalVaultImportJobRow[]>`
    UPDATE harness_shared.personal_vault_import_jobs
       SET cancel_requested = true,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           completed_at = CASE WHEN status = 'queued' THEN now() ELSE completed_at END,
           updated_at = now()
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid
       AND id = ${jobId}::uuid AND status IN ('queued', 'running')
    RETURNING *`;
  if (!rows[0]) return getPersonalVaultImportJob(sql, workspaceId, userId, jobId);
  let job = mapJob(rows[0]);
  if (job.status === 'cancelled' && job.storagePath) {
    await removeArchive(job.workspaceId, job.storagePath);
    const cleared = await sql<PersonalVaultImportJobRow[]>`
      UPDATE harness_shared.personal_vault_import_jobs
         SET storage_path = NULL, updated_at = now()
       WHERE workspace_id = ${job.workspaceId} AND user_id = ${job.userId}::uuid
         AND id = ${job.id}::uuid
      RETURNING *`;
    job = mapJob(cleared[0]!);
  }
  return job;
}

export async function retryPersonalVaultImportJob(
  sql: postgres.Sql,
  workspaceId: string,
  userId: string,
  jobId: string,
): Promise<PersonalVaultImportJob | null> {
  const rows = await sql<PersonalVaultImportJobRow[]>`
    UPDATE harness_shared.personal_vault_import_jobs
       SET status = 'queued', cancel_requested = false, attempt_count = 0,
           next_attempt_at = now(), lease_owner = NULL, lease_expires_at = NULL,
           last_error = NULL, completed_at = NULL, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}::uuid
       AND id = ${jobId}::uuid AND status = 'failed' AND storage_path IS NOT NULL
    RETURNING *`;
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function claimNextPersonalVaultImportJob(
  sql: postgres.Sql,
  workspaceId: string,
  leaseOwner: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<PersonalVaultImportJob | null> {
  const boundedLeaseSeconds = finiteInteger(leaseSeconds, DEFAULT_LEASE_SECONDS, 30, MAX_LEASE_SECONDS);
  const rows = await sql<PersonalVaultImportJobRow[]>`
    WITH candidate AS (
      SELECT workspace_id, user_id, id
        FROM harness_shared.personal_vault_import_jobs
       WHERE workspace_id = ${workspaceId}
         AND storage_path IS NOT NULL
         AND cancel_requested = false
         AND (
           (status = 'queued' AND next_attempt_at <= now())
           OR (status = 'running' AND (lease_expires_at <= now() OR lease_owner = ${leaseOwner}))
         )
       ORDER BY next_attempt_at, created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    )
    UPDATE harness_shared.personal_vault_import_jobs AS job
       SET status = 'running',
           attempt_count = attempt_count + 1,
           lease_owner = ${leaseOwner},
           lease_expires_at = now() + make_interval(secs => ${boundedLeaseSeconds}),
           started_at = COALESCE(started_at, now()),
           last_error = NULL,
           updated_at = now()
      FROM candidate
     WHERE job.workspace_id = candidate.workspace_id
       AND job.user_id = candidate.user_id
       AND job.id = candidate.id
    RETURNING job.*`;
  return rows[0] ? mapJob(rows[0]) : null;
}

async function refreshJob(sql: postgres.Sql, job: PersonalVaultImportJob): Promise<PersonalVaultImportJob> {
  const rows = await sql<PersonalVaultImportJobRow[]>`
    SELECT * FROM harness_shared.personal_vault_import_jobs
     WHERE workspace_id = ${job.workspaceId} AND user_id = ${job.userId}::uuid
       AND id = ${job.id}::uuid`;
  return mapJob(rows[0]!);
}

function withJobProvenance(job: PersonalVaultImportJob, document: PersonalDocumentInput): PersonalDocumentInput {
  return {
    ...document,
    sourceId: job.sourceId,
    providerAccountId: job.providerAccountId,
    metadata: {
      ...(document.metadata ?? {}),
      importJobId: job.id,
      importFilename: job.filename,
    },
  };
}

async function persistBatchProgress(
  sql: postgres.Sql,
  job: PersonalVaultImportJob,
  next: PersonalArchiveCheckpoint,
  bytesProcessed: number,
  seen: number,
  imported: number,
  warnings: string[],
  leaseSeconds: number,
): Promise<void> {
  const boundedWarnings = warnings.slice(0, MAX_WARNINGS);
  await sql`
    UPDATE harness_shared.personal_vault_import_jobs
       SET checkpoint = ${JSON.stringify(next)}::jsonb,
           bytes_processed = GREATEST(bytes_processed, ${bytesProcessed}),
           entries_processed = GREATEST(entries_processed, ${next.entryIndex}),
           documents_seen = documents_seen + ${seen},
           documents_imported = documents_imported + ${imported},
           warnings = COALESCE((
             SELECT jsonb_agg(value ORDER BY ordinal)
               FROM (
                 SELECT value, ordinal
                   FROM jsonb_array_elements(warnings || ${JSON.stringify(boundedWarnings)}::jsonb)
                        WITH ORDINALITY AS warning(value, ordinal)
                  ORDER BY ordinal
                  LIMIT ${MAX_WARNINGS}
               ) AS bounded
           ), '[]'::jsonb),
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           updated_at = now()
     WHERE workspace_id = ${job.workspaceId} AND user_id = ${job.userId}::uuid
       AND id = ${job.id}::uuid AND status = 'running'
       AND lease_owner = ${job.leaseOwner}`;
}

async function finishJob(
  sql: postgres.Sql,
  job: PersonalVaultImportJob,
  status: 'completed' | 'cancelled',
): Promise<void> {
  await sql`
    UPDATE harness_shared.personal_vault_import_jobs
       SET status = ${status}, lease_owner = NULL, lease_expires_at = NULL,
           completed_at = now(), last_error = NULL, updated_at = now()
     WHERE workspace_id = ${job.workspaceId} AND user_id = ${job.userId}::uuid
       AND id = ${job.id}::uuid`;
}

async function failJob(sql: postgres.Sql, job: PersonalVaultImportJob, cause: unknown): Promise<PersonalVaultImportStatus> {
  const terminal = job.attemptCount >= job.maxAttempts;
  const status: PersonalVaultImportStatus = terminal ? 'failed' : 'queued';
  const backoffSeconds = Math.min(3_600, 30 * (2 ** Math.max(0, job.attemptCount - 1)));
  await sql`
    UPDATE harness_shared.personal_vault_import_jobs
       SET status = ${status},
           next_attempt_at = now() + make_interval(secs => ${backoffSeconds}),
           lease_owner = NULL, lease_expires_at = NULL,
           last_error = ${errorText(cause)}, updated_at = now()
     WHERE workspace_id = ${job.workspaceId} AND user_id = ${job.userId}::uuid
       AND id = ${job.id}::uuid`;
  return status;
}

async function cleanupJobArchive(
  sql: postgres.Sql,
  job: PersonalVaultImportJob,
  removeArchive: typeof removePersonalVaultImportArchive,
): Promise<void> {
  if (!job.storagePath) return;
  await removeArchive(job.workspaceId, job.storagePath);
  await sql`
    UPDATE harness_shared.personal_vault_import_jobs
       SET storage_path = NULL, updated_at = now()
     WHERE workspace_id = ${job.workspaceId} AND user_id = ${job.userId}::uuid
       AND id = ${job.id}::uuid`;
}

export async function cleanupExpiredPersonalVaultImportArchives(
  sql: postgres.Sql,
  workspaceId: string,
  removeArchive: typeof removePersonalVaultImportArchive = removePersonalVaultImportArchive,
): Promise<number> {
  const rows = await sql<PersonalVaultImportJobRow[]>`
    SELECT * FROM harness_shared.personal_vault_import_jobs
     WHERE workspace_id = ${workspaceId} AND storage_path IS NOT NULL
       AND (status IN ('completed', 'cancelled') OR retained_until <= now())
     ORDER BY retained_until
     LIMIT 25`;
  let cleaned = 0;
  for (const row of rows) {
    const job = mapJob(row);
    try {
      await cleanupJobArchive(sql, job, removeArchive);
      cleaned += 1;
    } catch (cause) {
      await sql`
        UPDATE harness_shared.personal_vault_import_jobs
           SET last_error = ${`archive_cleanup_failed:${errorText(cause)}`}, updated_at = now()
         WHERE workspace_id = ${job.workspaceId} AND user_id = ${job.userId}::uuid
           AND id = ${job.id}::uuid`;
    }
  }
  return cleaned;
}

async function processClaimedJob(
  sql: postgres.Sql,
  job: PersonalVaultImportJob,
  options: Required<Pick<PersonalVaultImportBatchOptions, 'batchSize' | 'leaseSeconds'>> &
    Pick<
      PersonalVaultImportBatchOptions,
      'streamArchive' | 'upsertDocuments' | 'removeArchive' | 'verifyArchive'
    >,
): Promise<PersonalVaultImportBatchResult> {
  const streamArchive = options.streamArchive ?? streamPersonalArchiveFile;
  const upsertDocuments = options.upsertDocuments ?? upsertPersonalDocuments;
  const removeArchive = options.removeArchive ?? removePersonalVaultImportArchive;
  const verifyArchive = options.verifyArchive ?? verifyEncryptedPersonalArchiveDigest;
  const current = await refreshJob(sql, job);
  if (current.cancelRequested) {
    await finishJob(sql, current, 'cancelled');
    await cleanupJobArchive(sql, current, removeArchive);
    return {
      claimed: true,
      jobId: current.id,
      status: 'cancelled',
      documentsSeen: 0,
      documentsImported: 0,
      warnings: 0,
      error: null,
    };
  }
  if (!current.storagePath) throw new Error('personal_vault_import_archive_missing');

  const documents: PersonalDocumentInput[] = [];
  const warnings: string[] = [];
  let seen = 0;
  let next = current.checkpoint;
  let bytesProcessed = current.bytesProcessed;
  let exhausted = true;
  for await (const record of streamArchive(
    current.workspaceId,
    current.filename,
    current.storagePath,
    current.checkpoint,
  )) {
    next = record.checkpoint;
    bytesProcessed = Math.max(bytesProcessed, record.bytesProcessed);
    if (record.warning) warnings.push(record.warning);
    if (record.document) {
      seen += 1;
      documents.push(withJobProvenance(current, record.document));
    }
    if (seen + warnings.length >= options.batchSize) {
      exhausted = false;
      break;
    }
  }
  const imported = documents.length
    ? (await upsertDocuments(sql, current.workspaceId, current.userId, documents)).insertedOrUpdated
    : 0;
  if (seen > 0 || warnings.length > 0) {
    await persistBatchProgress(
      sql,
      current,
      next,
      bytesProcessed,
      seen,
      imported,
      warnings,
      options.leaseSeconds,
    );
  }
  if (exhausted) {
    await verifyArchive(
      current.workspaceId,
      current.storagePath,
      current.contentSha256,
    );
    await finishJob(sql, current, 'completed');
    await cleanupJobArchive(sql, current, removeArchive);
  } else {
    await sql`
      UPDATE harness_shared.personal_vault_import_jobs
         SET status = 'queued', next_attempt_at = now(),
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE workspace_id = ${current.workspaceId} AND user_id = ${current.userId}::uuid
         AND id = ${current.id}::uuid`;
  }
  return {
    claimed: true,
    jobId: current.id,
    status: exhausted ? 'completed' : 'queued',
    documentsSeen: seen,
    documentsImported: imported,
    warnings: warnings.length,
    error: null,
  };
}

/** Claim and advance at most one job; the routine cadence supplies the next bounded batch. */
export async function runPersonalVaultImportBatch(
  sql: postgres.Sql,
  workspaceId: string,
  options: PersonalVaultImportBatchOptions = {},
): Promise<PersonalVaultImportBatchResult> {
  const batchSize = finiteInteger(options.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const leaseSeconds = finiteInteger(
    options.leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    30,
    MAX_LEASE_SECONDS,
  );
  const leaseOwner = options.leaseOwner?.trim() || `system:personal-vault-import:${workspaceId}`;
  const removeArchive = options.removeArchive ?? removePersonalVaultImportArchive;
  await cleanupExpiredPersonalVaultImportArchives(sql, workspaceId, removeArchive);
  const job = await claimNextPersonalVaultImportJob(sql, workspaceId, leaseOwner, leaseSeconds);
  if (!job) {
    return {
      claimed: false,
      jobId: null,
      status: 'idle',
      documentsSeen: 0,
      documentsImported: 0,
      warnings: 0,
      error: null,
    };
  }
  try {
    return await processClaimedJob(sql, job, { ...options, batchSize, leaseSeconds });
  } catch (cause) {
    const status = await failJob(sql, job, cause);
    return {
      claimed: true,
      jobId: job.id,
      status,
      documentsSeen: 0,
      documentsImported: 0,
      warnings: 0,
      error: errorText(cause),
    };
  }
}
