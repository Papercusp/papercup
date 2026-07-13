import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
const rows = await sql`
  select item_id, attempt, fired_at, outcome, resolved_by, fire_error
  from harness_shared.improvement_dispatches
  where fire_error ilike '%MODULE_NOT_FOUND%'
  order by fired_at desc limit 15`;
for (const r of rows) {
  console.log('----', r.item_id, r.attempt, r.fired_at, r.outcome, r.resolved_by);
  console.log(r.fire_error);
}
console.log('total count check:');
const cnt = await sql`select count(*) from harness_shared.improvement_dispatches where fire_error ilike '%MODULE_NOT_FOUND%'`;
console.log(cnt);
const cnt2 = await sql`select count(*) from harness_shared.improvement_dispatches where outcome='orphaned'`;
console.log('orphaned total', cnt2);
const cnt3 = await sql`select count(*) from harness_shared.improvement_dispatches`;
console.log('all total', cnt3);
process.exit(0);
