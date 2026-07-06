import { getOrgPg } from '@papercusp/db-org';
const { sql } = getOrgPg();
async function poll() {
  for (let i = 0; i < 20; i++) {
    const routine = await sql`select last_fired_at from harness_shared.routines where name='cargo-test'`;
    const runs = await sql`select count(*) from harness_shared.test_runs where framework='cargo' and created_at > now() - interval '10 minutes'`;
    console.log(i, JSON.stringify(routine), JSON.stringify(runs));
    if (Number(runs[0].count) > 0) break;
    await new Promise(r => setTimeout(r, 10000));
  }
  await sql.end({timeout:5});
}
poll();
