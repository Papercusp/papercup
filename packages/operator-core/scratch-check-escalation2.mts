import { getHarnessAdminUrl } from './lib/embedded-pg-discovery.ts';
import postgres from 'postgres';

const url = getHarnessAdminUrl();
const sql = postgres(url, { max: 1 });
const owner = 'su-3bf3e5a7-57a1-4767-b4f0-1a6044674a28';

const pres = await sql`
  SELECT owner_id, heartbeat_at, extract(epoch from heartbeat_at)*1000 as ms
  FROM harness_shared.coord_presence
  WHERE owner_id = ${owner}
`;
console.log('presence:', JSON.stringify(pres, null, 2));
console.log('now:', Date.now());

// any work items currently assigned to this owner?
const wi = await sql`
  SELECT id, kind, state, title, updated_at
  FROM harness_shared.work_items
  WHERE assignee = ${owner} OR taken_by = ${owner}
  ORDER BY updated_at DESC LIMIT 10
`.catch(e => [{error: String(e)}]);
console.log('work items:', JSON.stringify(wi, null, 2));

await sql.end();
