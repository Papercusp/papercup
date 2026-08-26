/** Durable, bounded Personal Vault historical-import worker (P-009 / D-007). */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  runPersonalVaultImportBatch,
  type PersonalVaultImportBatchOptions,
  type PersonalVaultImportBatchResult,
} from '../../personal-vault/import-jobs';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface PersonalVaultImportActionDeps {
  sql?: postgres.Sql;
  runBatch?: typeof runPersonalVaultImportBatch;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function runPersonalVaultImportAction(
  ctx: SystemActionCtx,
  provided: PersonalVaultImportActionDeps = {},
): Promise<PersonalVaultImportBatchResult> {
  const sql = provided.sql ?? getOrgPg().sql;
  const runBatch = provided.runBatch ?? runPersonalVaultImportBatch;
  const options: PersonalVaultImportBatchOptions = {
    batchSize: boundedInteger(ctx.triggerConfig.batch_size, 100, 1, 1_000),
    leaseSeconds: boundedInteger(ctx.triggerConfig.lease_seconds, 600, 30, 3_600),
    leaseOwner: `system:personal-vault-import:${ctx.installSlug}`,
  };
  return runBatch(sql, ctx.workspaceId, options);
}

registerSystemAction('personal-vault-import', async (ctx) => {
  const result = await runPersonalVaultImportAction(ctx);
  if (result.claimed) {
    console.log(
      `[personal-vault-import] job=${result.jobId} status=${result.status} ` +
        `seen=${result.documentsSeen} imported=${result.documentsImported} ` +
        `warnings=${result.warnings}${result.error ? ` error=${result.error}` : ''}`,
    );
  }
});
