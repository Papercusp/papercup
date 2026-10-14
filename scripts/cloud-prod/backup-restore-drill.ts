#!/usr/bin/env -S npx tsx
/** P-009: non-destructive Cloud SQL PITR drill. Reuses P-004's gcloud/Data API
 * seams. `plan` reads only; `drill` creates a uniquely named canary schema and
 * scratch instance, checks both sides of a server-clock timestamp, then cleans
 * up its own resources. It never restores over the production instance.
 */
import { randomBytes } from 'node:crypto';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { executeSql, jsonCells, makeCtx, ROOT_SECRET, type Ctx } from './provision-cloud-sql';

export const RESTORE_DEADLINE_MS = 60 * 60 * 1000;
export const EXPORT_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export interface DrillReceipt {
  source: string;
  scratch: string;
  schema: string;
  restorePoint: string;
  latestRecoveryTime: string;
  rpoMs: number;
  rtoMs: number;
  beforeRows: number;
  afterRows: number;
  passed: boolean;
  cleanup: { sourceCanaryRemoved: boolean; sourceDataApiClosed: boolean; scratchDeleted: boolean };
}

/** Freshness measures the last COMPLETED export of EACH database. An object
 * path, an attempted export, or a failed Cloud SQL operation is not a backup.
 */
export function judgeExportHealth(databases: readonly string[], operations: readonly {
  status?: string; error?: unknown; endTime?: string;
  exportContext?: { fileType?: string; databases?: string[]; uri?: string };
}[], bucket: string, nowMs = Date.now()): { ok: boolean; stale: string[]; latest: Record<string, string> } {
  const latest: Record<string, string> = {};
  for (const operation of operations) {
    if (operation.status !== 'DONE' || operation.error || operation.exportContext?.fileType !== 'SQL' ||
      !operation.exportContext.uri?.startsWith(`gs://${bucket}/`)) continue;
    const end = Date.parse(operation.endTime ?? '');
    if (!Number.isFinite(end) || end > nowMs) continue;
    for (const db of operation.exportContext.databases ?? []) {
      if (databases.includes(db) && (!latest[db] || end > Date.parse(latest[db]!))) latest[db] = operation.endTime!;
    }
  }
  const stale = databases.filter(db => !latest[db] || nowMs - Date.parse(latest[db]!) > EXPORT_MAX_AGE_MS);
  return { ok: stale.length === 0, stale, latest };
}

export function judgeRestore(input: Pick<DrillReceipt, 'beforeRows' | 'afterRows' | 'rtoMs' | 'rpoMs'>): boolean {
  return input.beforeRows === 1 && input.afterRows === 0 &&
    Number.isFinite(input.rtoMs) && input.rtoMs >= 0 && input.rtoMs <= RESTORE_DEADLINE_MS &&
    Number.isFinite(input.rpoMs) && input.rpoMs >= 0;
}

interface DrillOptions {
  ctx?: Ctx;
  nonce?: string;
  now?: () => number;
  pollMs?: number;
}

export async function restoreDrill(options: DrillOptions = {}): Promise<DrillReceipt> {
  const ctx = options.ctx ?? makeCtx();
  const nonce = options.nonce ?? randomBytes(6).toString('hex');
  if (!/^[a-f0-9]{12}$/.test(nonce)) throw new Error('restore_drill_nonce_invalid');
  if (ctx.dryRun) throw new Error('restore_drill_dry_run_use_plan');
  const now = options.now ?? Date.now;
  const scratch = `pc-pitr-drill-${nonce}`;
  const schema = `_p009_restore_${nonce}`;
  const scope = [`--project=${ctx.spec.project}`, '--quiet'];
  const run = async (args: string[]) => {
    const result = await ctx.gcloud([...args, ...scope, '--format=json']);
    if (result.code !== 0) throw new Error(`restore_drill_command_failed:${args.slice(0, 3).join(':')}:${result.code}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  };
  const source = await run(['sql', 'instances', 'describe', ctx.spec.instance]);
  if (source.name !== ctx.spec.instance || source.state !== 'RUNNABLE' ||
    !source.settings?.backupConfiguration?.enabled || !source.settings.backupConfiguration.pointInTimeRecoveryEnabled ||
    source.settings?.dataApiAccess === 'ALLOW_DATA_API') throw new Error('restore_drill_source_precondition_failed');
  const existing = await ctx.gcloud(['sql', 'instances', 'describe', scratch, ...scope, '--format=json']);
  if (existing.code === 0) throw new Error('restore_drill_scratch_already_exists');
  if (!/NOT_FOUND|was not found|does not exist/i.test(existing.stderr)) throw new Error('restore_drill_scratch_existence_unknown');
  const started = now();
  const receipt: DrillReceipt = { source: ctx.spec.instance, scratch, schema, restorePoint: '', latestRecoveryTime: '',
    rpoMs: 0, rtoMs: 0, beforeRows: 0, afterRows: 0, passed: false,
    cleanup: { sourceCanaryRemoved: false, sourceDataApiClosed: false, scratchDeleted: false } };
  let canaryCreated = false;
  let cloneAccepted = false;
  let failure: unknown;
  const cleanupErrors: string[] = [];
  const patchApi = async (instance: string, enabled: boolean) => run(['sql', 'instances', 'patch', instance,
    `--data-api-access=${enabled ? 'ALLOW_DATA_API' : 'DISALLOW_DATA_API'}`]);
  const sql = async (instance: string, statement: string) => {
    const result = await executeSql({ ...ctx, spec: { ...ctx.spec, instance } }, 'postgres', ROOT_SECRET, 'papercusp_hosted', statement);
    if (result.code !== 0) throw new Error(`restore_drill_sql_failed:${instance}`);
    return jsonCells(result.stdout)[0] as Record<string, unknown> | undefined;
  };
  const checkDeadline = () => { if (now() - started > RESTORE_DEADLINE_MS) throw new Error('restore_drill_deadline_exceeded'); };
  try {
    await patchApi(ctx.spec.instance, true);
    await sql(ctx.spec.instance, `CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.canary (marker text PRIMARY KEY); INSERT INTO ${schema}.canary VALUES ('before');`);
    canaryCreated = true;
    const point = await sql(ctx.spec.instance, "SELECT json_build_object('restorePoint', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))");
    receipt.restorePoint = String(point?.restorePoint ?? '');
    if (!Number.isFinite(Date.parse(receipt.restorePoint))) throw new Error('restore_drill_server_timestamp_missing');
    // Separate commits on opposite sides of the server timestamp discriminate
    // real PITR from a current-state clone, which would preserve both markers.
    await ctx.sleep(2000);
    await sql(ctx.spec.instance, `INSERT INTO ${schema}.canary VALUES ('after');`);
    await patchApi(ctx.spec.instance, false);
    receipt.cleanup.sourceDataApiClosed = true;
    for (;;) {
      checkDeadline();
      const recovery = await run(['sql', 'instances', 'get-latest-recovery-time', ctx.spec.instance]);
      receipt.latestRecoveryTime = String(recovery.latestRecoveryTime ?? '');
      const latest = Date.parse(receipt.latestRecoveryTime);
      const earliest = Date.parse(recovery.earliestRecoveryTime ?? '');
      const pointMs = Date.parse(receipt.restorePoint);
      if (Number.isFinite(earliest) && pointMs < earliest) throw new Error('restore_drill_timestamp_outside_recovery_window');
      if (Number.isFinite(latest) && latest >= pointMs) break;
      ctx.log(`restore-drill waiting for WAL through ${receipt.restorePoint}`);
      await ctx.sleep(options.pollMs ?? 15_000);
    }
    receipt.rpoMs = Math.max(0, now() - Date.parse(receipt.latestRecoveryTime));
    const operation = await run(['sql', 'instances', 'clone', ctx.spec.instance, scratch, `--point-in-time=${receipt.restorePoint}`, '--async']);
    cloneAccepted = true;
    if (typeof operation.name !== 'string' || !operation.name) throw new Error('restore_drill_operation_identity_missing');
    for (;;) {
      checkDeadline();
      const state = await run(['sql', 'operations', 'describe', operation.name]);
      if (state.error) throw new Error('restore_drill_clone_failed');
      if (state.status === 'DONE') break;
      ctx.log(`restore-drill ${scratch} operation ${operation.name} ${state.status}`);
      await ctx.sleep(options.pollMs ?? 15_000);
    }
    const restored = await run(['sql', 'instances', 'describe', scratch]);
    if (restored.name !== scratch || restored.state !== 'RUNNABLE' || restored.settings?.ipConfiguration?.ipv4Enabled !== false ||
      restored.settings?.ipConfiguration?.privateNetwork !== source.settings?.ipConfiguration?.privateNetwork) throw new Error('restore_drill_scratch_identity_failed');
    await patchApi(scratch, true);
    const counts = await sql(scratch, `SELECT json_build_object('beforeRows', count(*) FILTER (WHERE marker='before'), 'afterRows', count(*) FILTER (WHERE marker='after')) FROM ${schema}.canary`);
    receipt.beforeRows = Number(counts?.beforeRows);
    receipt.afterRows = Number(counts?.afterRows);
    receipt.rtoMs = now() - started;
    receipt.passed = judgeRestore(receipt);
    if (!receipt.passed) throw new Error('restore_drill_verification_failed');
  } catch (error) { failure = error; }
  finally {
    // Cleanup continues through independent failures. A failed drill still must
    // close the temporary Data API window and remove its disposable resources.
    if (canaryCreated) {
      try {
        await patchApi(ctx.spec.instance, true);
        await sql(ctx.spec.instance, `DROP SCHEMA ${schema} CASCADE`);
        receipt.cleanup.sourceCanaryRemoved = true;
      } catch { cleanupErrors.push('source_canary_cleanup_failed'); }
    }
    try { await patchApi(ctx.spec.instance, false); receipt.cleanup.sourceDataApiClosed = true; }
    catch { cleanupErrors.push('source_data_api_cleanup_failed'); }
    if (cloneAccepted) {
      try {
        // Cloud SQL clones inherit production deletion protection. Clearing it
        // is safe only for this nonce-owned scratch; never patch the source.
        // Close the scratch API first so a failed delete leaves no open window.
        await run(['sql', 'instances', 'patch', scratch, '--no-deletion-protection', '--data-api-access=DISALLOW_DATA_API']);
        const disposable = await run(['sql', 'instances', 'describe', scratch]);
        if (disposable.name !== scratch || disposable.settings?.deletionProtectionEnabled !== false ||
          disposable.settings?.dataApiAccess === 'ALLOW_DATA_API') throw new Error('restore_drill_scratch_cleanup_guard_failed');
        await run(['sql', 'instances', 'delete', scratch]); receipt.cleanup.scratchDeleted = true;
      }
      catch { cleanupErrors.push('scratch_cleanup_failed'); }
    }
    ctx.log(JSON.stringify({ ...receipt, cleanupErrors }));
  }
  if (cleanupErrors.length) throw new Error(`restore_drill_cleanup_incomplete:${cleanupErrors.join(':')}`);
  if (failure) throw failure;
  return receipt;
}

export async function main(args: string[]): Promise<number> {
  if (args.length !== 1 || !['plan', 'drill'].includes(args[0]!)) {
    process.stderr.write('usage: backup-restore-drill.ts plan | drill\n'); return 2;
  }
  const ctx = makeCtx();
  if (args[0] === 'plan') {
    process.stdout.write(`${JSON.stringify({ source: ctx.spec.instance, databases: ctx.spec.databases,
      deadlineMs: RESTORE_DEADLINE_MS, mode: 'read-only', steps: ['check PITR window', 'create isolated canary schema',
        'choose server timestamp between commits', 'wait for WAL', 'clone to new scratch instance',
        'verify before present and after absent', 'remove own scratch and canary; close Data API'],
      recovery: await ctx.gcloud(['sql', 'instances', 'get-latest-recovery-time', ctx.spec.instance, `--project=${ctx.spec.project}`, '--format=json']) }, null, 2)}\n`);
    return 0;
  }
  await restoreDrill({ ctx });
  return 0;
}

if (isCliEntry(import.meta.url)) main(process.argv.slice(2)).then(code => process.exit(code), error => {
  const message = error instanceof Error && /^restore_drill_[a-z_:0-9-]+$/.test(error.message) ? error.message : 'restore_drill_unclassified_failure';
  process.stderr.write(`${message}; reconcile receipt and remote resources before retrying\n`); process.exit(1);
});
