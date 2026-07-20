import postgres from 'postgres';
import { applyPendingMigrations } from '@papercusp/embedded-postgres-server';
import path from 'node:path';

const url = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/wi5635_scratch';
const sqlDir = path.resolve('/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/libs/db/sql');

const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  const { appliedCount, totalKnown, failed } = await applyPendingMigrations({
    client,
    sqlDir,
    continueOnError: true,
    log: (s) => console.log(`[mig] ${s}`),
  });
  console.log(`applied=${appliedCount} totalKnown=${totalKnown} failed=${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.error(`FAILED ${f.file}: ${f.error}`);
  }
} finally {
  await client.end({ timeout: 5 });
}
