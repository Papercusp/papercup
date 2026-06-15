import { getOrgPg } from '@papercusp/db-org';
(async()=>{const sql=getOrgPg().sql;
const ro=await sql`SELECT role, exit_code, started_at, length(out_body) ol, left(out_body, 500) ob, left(err_body,400) eb FROM harness_shared.harness_run_output WHERE harness_slug=${process.argv[2]} ORDER BY started_at ASC`;
for(const r of ro as any[]){console.log('===',r.role,'exit',r.exit_code,'len',r.ol,'@',new Date(Number(r.started_at)).toISOString().slice(11,19));console.log('OUT:',JSON.stringify(r.ob));if(r.eb)console.log('ERR:',JSON.stringify(r.eb));}
await sql.end();})().catch(e=>console.error(e.message));
