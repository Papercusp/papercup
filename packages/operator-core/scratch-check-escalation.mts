import { getHarnessAdminUrl } from './lib/embedded-pg-discovery.ts';
import postgres from 'postgres';

const url = getHarnessAdminUrl();
const sql = postgres(url, { max: 1 });

const rows = await sql`
  SELECT harness_slug, phase, escalation, mtime_ms, workspace_id
  FROM harness_shared.harness_escalations
  WHERE phase = ${'mcp-dark-int:su-3bf3e5a7-57a1-4767-b4f0-1a6044674a28'}
`;
console.log('escalation row:', JSON.stringify(rows, null, 2));

const presRows = await sql`
  SELECT owner_id, session_state, last_active_at, fleet_slug
  FROM harness_shared.agent_presence
  WHERE owner_id = ${'su-3bf3e5a7-57a1-4767-b4f0-1a6044674a28'}
`.catch((e) => [{ error: String(e) }]);
console.log('presence:', JSON.stringify(presRows, null, 2));

await sql.end();
