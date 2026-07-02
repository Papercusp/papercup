import { describe, it, expect } from 'vitest';
import { createOrgTestDb } from '../../apps/operator/test/_org-test-db';

describe('diag: node_id entropy across two sequential org test DBs', () => {
  it('prints pid/random/node_id for two DBs created back-to-back', async () => {
    const a = await createOrgTestDb();
    const b = await createOrgTestDb();
    const rowsA = await a.adminSql`SELECT pg_backend_pid() AS pid, random()::text AS r, node_id FROM harness_shared.hlc_clock WHERE id=1`;
    const rowsB = await b.adminSql`SELECT pg_backend_pid() AS pid, random()::text AS r, node_id FROM harness_shared.hlc_clock WHERE id=1`;
    // eslint-disable-next-line no-console
    console.log('A:', JSON.stringify(rowsA[0]));
    // eslint-disable-next-line no-console
    console.log('B:', JSON.stringify(rowsB[0]));
    const verA = await a.adminSql`SHOW server_version`;
    // eslint-disable-next-line no-console
    console.log('PG version:', JSON.stringify(verA[0]));
    await a.cleanup();
    await b.cleanup();
    expect(true).toBe(true);
  }, 60000);
});
