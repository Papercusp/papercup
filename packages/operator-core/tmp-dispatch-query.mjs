import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
const rows = await sql`
  select id, workspace_id, item_id, attempt, runner_harness, fired_at, fire_result, fire_error, spawned_run_id, outcome, resolved_at, resolved_by
  from harness_shared.improvement_dispatches
  where item_id = 'EI-10533'
  order by fired_at desc`;
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
