import { getOrgPg } from '@papercusp/db-org';
(async () => {
  const sql = getOrgPg().sql;
  const slug = 'xbench-hsbm4u4p';
  // cost
  const cost = await sql`SELECT SUM(COALESCE(input_tokens,0))::text ti, SUM(COALESCE(output_tokens,0))::text too, SUM(COALESCE(cost_usd,0))::text c, COUNT(DISTINCT run_id)::text turns, COUNT(*)::text samples FROM harness_shared.agent_usage_samples WHERE harness_slug=${slug}`;
  console.log('COST', JSON.stringify(cost[0]));
  // feature final status
  const feat = await sql`SELECT feature_id, status, attempts, notes FROM harness_shared.harness_features_consolidated WHERE harness_slug=${slug}`;
  console.log('FEATURE', JSON.stringify(feat));
  // any run output rows
  try {
    const cols = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='harness_shared' AND table_name LIKE '%run_output%'`;
    console.log('run_output tables:', JSON.stringify(cols.map((c:any)=>c.table_name)));
    const ro = await sql`SELECT role, left(output, 600) o, ts FROM harness_shared.harness_run_output_consolidated WHERE harness_slug=${slug} ORDER BY ts DESC LIMIT 5`;
    console.log('RUN_OUTPUT', JSON.stringify(ro, null, 2));
  } catch(e){ console.log('run_output err', (e as Error).message); }
  await sql.end();
})().catch(e=>{console.error('ERR', e.message); process.exit(1)});
