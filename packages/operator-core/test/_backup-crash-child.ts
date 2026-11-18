/** Isolated DBOS restore worker for backup-workflow-crash-resume.integration.test.ts. */
import postgres from 'postgres';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { configureBackup, WorkspaceBackup, type SnapshotResult } from '@papercusp/backup';

const dsn = process.env.BACKUP_CRASH_DB_DSN;
const root = process.env.BACKUP_CRASH_ROOT;
const operationId = process.env.BACKUP_CRASH_OP_ID;
const mode = process.env.BACKUP_CRASH_MODE;
const operation = process.env.BACKUP_CRASH_OPERATION ?? 'restore';
if (!dsn || !root || !operationId || (mode !== 'crash' && mode !== 'recover')) {
  throw new Error('missing isolated backup crash fixture configuration');
}

const sql = postgres(dsn, { max: 2, onnotice: () => {} });
configureBackup({
  getSql: () => sql,
  workspacesRoot: () => root,
  ensureSchema: async () => {},
  getHarnessAdminUrl: () => ({ url: dsn, source: 'test' }),
});
DBOS.setConfig({
  name: 'backup-crash-p023',
  systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos',
  applicationVersion: 'backup-crash-p023-v1',
  runAdminServer: false,
});

const workflow = await import('../lib/dbos/backup-workflow');
const backup = new WorkspaceBackup({ workspaceId: 'ws-p023-crash', workspaceRoot: root });
backup.snapshot = async (): Promise<SnapshotResult> => {
  await sql.unsafe('INSERT INTO test_backup.calls (phase, mode) VALUES ($1, $2)', ['safety-snapshot', mode]);
  return { snapshotId: 1, kopiaSnapshotId: 'safety-p023', bytesAdded: 0, durationMs: 1 };
};
(backup as unknown as { kopia: (args: string[], opts: unknown) => Promise<string> }).kopia =
  async (args: string[]): Promise<string> => {
    if (args[0] !== 'snapshot' || args[1] !== 'restore') throw new Error('unexpected kopia call');
    await sql.unsafe('INSERT INTO test_backup.calls (phase, mode) VALUES ($1, $2)', ['restore-apply', mode]);
    if (mode === 'crash') {
      process.kill(process.pid, 'SIGKILL');
      await new Promise<never>(() => {});
    }
    const target = args[3]!;
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'marker.txt'), 'RESTORED');
    return '';
  };
workflow.wireBackupStepRunner();
workflow.setRestoreInPlaceExecutor((input) => backup.restoreInPlace({
  kopiaSnapshotId: input.kopiaSnapshotId,
  target: input.target,
  skipSafetySnapshot: input.skipSafetySnapshot,
}));
if (operation === 'snapshot') {
  workflow.setBackupSnapshotExecutor(async (workspaceId, reason, _context, resumeSnapshotId) => {
    if (workspaceId !== 'ws-p023-crash' || reason !== 'pre_destructive' || resumeSnapshotId !== 80670) {
      throw new Error('snapshot recovery lost its exact original receipt');
    }
    const snapshotId = await DBOS.runStep(async () => {
      await sql.unsafe('INSERT INTO test_backup.calls (phase, mode) VALUES ($1, $2)', ['snapshot-receipt:' + resumeSnapshotId, mode]);
      return resumeSnapshotId;
    }, { name: 'backup-resume-receipt' });
    return DBOS.runStep(async () => {
      await sql.unsafe('INSERT INTO test_backup.calls (phase, mode) VALUES ($1, $2)', ['snapshot-complete:' + snapshotId, mode]);
      if (mode === 'crash') {
        process.kill(process.pid, 'SIGKILL');
        await new Promise<never>(() => {});
      }
      return { snapshotId, kopiaSnapshotId: 'resumed-80670', bytesAdded: 0, durationMs: 1 };
    }, { name: 'backup-resume-complete' });
  });
}

await DBOS.launch();
const input = {
  workspaceId: 'ws-p023-crash',
  kopiaSnapshotId: 'snapshot-p023',
  target: join(root, 'live'),
};
const snapshotInput = {
  workspaceId: 'ws-p023-crash', reason: 'pre_destructive' as const, resumeSnapshotId: 80670,
};
if (mode === 'crash') {
  if (operation === 'snapshot') {
    await workflow.startBackupSnapshotWorkflow(snapshotInput, operationId);
  } else {
    await workflow.startBackupRestoreInPlaceWorkflow(input, operationId);
  }
  throw new Error('crash point was not reached');
}
const workflowId = operation === 'snapshot'
  ? 'backup-snapshot:ws-p023-crash:pre_destructive:' + operationId
  : 'backup-restore-in-place:ws-p023-crash:' + operationId;
const restored = await DBOS.getResult(workflowId, 30);
if (operation === 'snapshot'
  ? restored?.snapshotId !== snapshotInput.resumeSnapshotId || restored?.kopiaSnapshotId !== 'resumed-80670'
  : restored?.targetPath !== input.target || restored?.prevSnapshotId !== 'safety-p023') {
  throw new Error('recovered restore returned the wrong receipt');
}
await DBOS.shutdown();
await sql.end({ timeout: 5 });
process.stdout.write(operation === 'snapshot' ? 'BACKUP_SNAPSHOT_RECOVERED\n' : 'BACKUP_RECOVERED\n');
