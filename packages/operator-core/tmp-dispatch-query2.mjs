import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
const rows = await sql`
  select fire_error
  from harness_shared.improvement_dispatches
  where item_id = 'EI-10533'
  order by fired_at desc limit 1`;
console.log(rows[0]?.fire_error ?? 'NONE');
process.exit(0);
