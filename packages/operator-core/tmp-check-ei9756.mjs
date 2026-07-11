import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
const sid = '893b87f9-da32-4c87-a9a9-28ccafec01a9';
const adv = await sql`SELECT id, coord_owner_id, ended_at, agent, session_id FROM harness_shared.adv_sessions WHERE session_id = ${sid}`;
console.log('adv_sessions:', JSON.stringify(adv, null, 2));
const arch = await sql`SELECT source_kind, session_id, owner, cwd, session_root, archived_at FROM harness_shared.session_archives WHERE session_id = ${sid}`;
console.log('session_archives:', JSON.stringify(arch, null, 2));
process.exit(0);
