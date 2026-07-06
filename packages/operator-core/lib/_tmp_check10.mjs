import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
async function poll() {
  for (let i = 0; i < 15; i++) {
    const runs = await sql`select count(*) from harness_shared.test_runs where framework='cargo' and created_at > now() - interval '10 minutes'`;
    console.log(i, JSON.stringify(runs));
    await new Promise(r => setTimeout(r, 10000));
  }
  await sql.end({timeout:5});
}
poll();
