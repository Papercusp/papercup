import { getOrgPg } from '@papercusp/db-org';
(async () => {
  const sql = getOrgPg().sql;
  const slug = process.argv[2];
  const cost = await sql`SELECT SUM(COALESCE(input_tokens,0))::text ti, SUM(COALESCE(output_tokens,0))::text too, SUM(COALESCE(cache_read_tokens,0))::text cr, SUM(COALESCE(cost_usd,0))::text c, COUNT(DISTINCT run_id)::text turns, COUNT(*)::text samples FROM harness_shared.agent_usage_samples WHERE harness_slug=${slug}`;
  console.log('COST', JSON.stringify(cost[0]));
  const models = await sql`SELECT DISTINCT model, model_class, role FROM harness_shared.agent_usage_samples WHERE harness_slug=${slug}`;
  console.log('MODELS', JSON.stringify(models));
  const ro = await sql`SELECT role, exit_code, left(out_body,200) ob FROM harness_shared.harness_run_output WHERE harness_slug=${slug} ORDER BY started_at DESC LIMIT 3`;
  console.log('LAST OUTPUTS', JSON.stringify(ro, null, 1));
  await sql.end();
})().catch(e=>console.error('ERR',e.message));
