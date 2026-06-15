import { getOrgPg } from '@papercusp/db-org';
(async () => {
  const sql = getOrgPg().sql;
  const slug = 'xbench-hsbm4u4p';
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='harness_shared' AND table_name='harness_run_output' ORDER BY ordinal_position`;
  console.log('cols:', cols.map((c:any)=>c.column_name).join(', '));
  const ro = await sql`SELECT * FROM harness_shared.harness_run_output WHERE harness_slug=${slug} ORDER BY 1 DESC LIMIT 5`;
  console.log('ROWS', ro.length);
  for (const r of ro) {
    const obj:any = r;
    console.log('--- role=', obj.role, 'ts=', obj.ts);
    const out = obj.output ?? obj.stdout ?? obj.text ?? obj.body ?? '';
    console.log(String(out).slice(0, 1200));
  }
  // the usage sample's model/role
  const us = await sql`SELECT role, model, model_class, input_tokens, output_tokens, cost_usd, cost_source, run_id FROM harness_shared.agent_usage_samples WHERE harness_slug=${slug}`;
  console.log('USAGE', JSON.stringify(us, null, 2));
  await sql.end();
})().catch(e=>{console.error('ERR', e.message); process.exit(1)});
