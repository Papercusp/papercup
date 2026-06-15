import { getOrgPg } from '@papercusp/db-org';
(async () => {
  const sql = getOrgPg().sql;
  const slug = 'xbench-hsbm4u4p';
  const ro = await sql`SELECT role, exit_code, duration_ms, left(out_body, 1500) ob, left(err_body, 500) eb FROM harness_shared.harness_run_output WHERE harness_slug=${slug}`;
  for (const r of ro as any[]) {
    console.log('=== role', r.role, 'exit', r.exit_code, 'dur', r.duration_ms);
    console.log('OUT_BODY:', JSON.stringify(r.ob));
    console.log('ERR_BODY:', JSON.stringify(r.eb));
  }
  await sql.end();
})().catch(e=>{console.error('ERR', e.message); process.exit(1)});
