import { writeSync } from 'node:fs';
import { DBOS } from '@dbos-inc/dbos-sdk';
import postgres from 'postgres';

const [mode, harnessSlug, point, workflowId] = process.argv.slice(2);
const dsn = process.env.REFERENCE_FANOUT_TEST_DSN;
if (!dsn || !new URL(dsn).pathname.startsWith('/org_')) throw new Error('Private reference fan-out test database required');
if (!['init', 'admit', 'work'].includes(mode)) throw new Error('Unknown reference fan-out test operation');
process.env.HARNESS_ADMIN_DATABASE_URL = dsn;
process.env.HARNESS_DATABASE_URL = dsn;
process.env.DATABASE_URL = dsn;
process.env.DBOS__APPVERSION = 'reference-fanout-test-v1';
process.env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION = process.env.DBOS__APPVERSION;
const workspaceId = 'reference-fanout-test';
const sql = postgres(dsn, { max: 2, onnotice() {} });
const { outboxFanoutDeps } = await import('../lib/sync/hyperbee/fanout-projection.ts');
const { dispatchOutboxFanout } = await import('../lib/sync/hyperbee/durable-fanout.ts');
const { retryPendingFanouts } = await import('../lib/sync/hyperbee/outbox-drain.ts');

if (mode === 'admit') {
  const result = await retryPendingFanouts({ workspaceId, harnessSlug }, sql, {
    fanout: row => dispatchOutboxFanout(workspaceId, row),
  });
  writeSync(1, 'FANOUT_SWEEP ' + JSON.stringify(result) + '\n');
} else {
  DBOS.setConfig({ name: 'reference-fanout-test', applicationVersion: process.env.DBOS__APPVERSION,
    systemDatabaseUrl: dsn, systemDatabaseSchemaName: 'dbos', runAdminServer: false });
  await import('../lib/dbos/reference-fanout-workflow.ts');
  const interrupt = async (boundary: string) => {
    if (boundary !== point) return;
    writeSync(1, 'FANOUT_BOUNDARY ' + boundary + '\n');
    if (point === 'graceful') {
      await DBOS.shutdown();
      process.exit(0);
    }
    process.kill(process.pid, 'SIGKILL');
    await new Promise<never>(() => {});
  };
  const resolve = outboxFanoutDeps.resolve;
  outboxFanoutDeps.resolve = async object => {
    if (point === 'refresh-error') {
      writeSync(1, 'FANOUT_BOUNDARY refresh-error\n');
      throw new Error('Test recipient refresh failed');
    }
    const recipients = await resolve(object);
    await interrupt('mid-refresh');
    return recipients;
  };
  const deliver = outboxFanoutDeps.deliver;
  let attempts = 0;
  outboxFanoutDeps.deliver = async (...args) => {
    if (++attempts === 2) {
      await interrupt('between-recipients');
      await interrupt('graceful');
    }
    const outcome = await deliver(...args);
    if (attempts === 1 && point === 'hold-before-ack') {
      if (!process.send) throw new Error('This boundary requires a parent process');
      process.send('recipient-written');
      await new Promise<never>(() => {});
    }
    if (attempts === 1) await interrupt('before-ack');
    return outcome;
  };
  await DBOS.launch();
  if (mode === 'work') {
    const count = await DBOS.getResult<number>(workflowId, 60);
    if (count === null) throw new Error('Private reference fan-out did not settle ' + workflowId);
    writeSync(1, 'FANOUT_COMPLETE ' + workflowId + '\n');
  }
  await DBOS.shutdown();
}
await sql.end({ timeout: 2 });
process.exit(0);
