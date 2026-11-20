import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { sweepExpiredFacts } from '../lib/agent-facts/store.ts';

process.once('message', async (request: { database: string; boundary: 'before-commit' | 'after-commit' }) => {
  const sql = getOrgPg().sql;
  // Only this suite's disposable database may be interrupted.
  const [db] = await sql`SELECT current_database() AS name`;
  if (!request.database.startsWith('org') || db.name !== request.database) throw new Error('Private database mismatch');
  const pause = async () => {
    process.send!({ boundary: request.boundary, pid: process.pid });
    await new Promise<void>(() => {});
  };
  await sql.begin(async tx => {
    await sweepExpiredFacts(tx as unknown as Sql);
    if (request.boundary === 'before-commit') await pause();
  });
  await pause();
});
