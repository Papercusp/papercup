import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import postgres from 'postgres';
(async () => {
  const url = await getHarnessAdminUrl();
  console.log('ADMIN_URL=', url.replace(/:[^:@/]+@/, ':***@'));
  const sql = postgres(url, { max: 1 });
  try {
    const cols = await sql`select column_name from information_schema.columns where table_schema='harness_shared' and table_name='agent_usage_samples' order by ordinal_position`;
    console.log('agent_usage_samples cols:', cols.map((c: any) => c.column_name).join(', '));
    const fcols = await sql`select column_name from information_schema.columns where table_schema='harness_shared' and table_name='harness_features_consolidated' order by ordinal_position`;
    console.log('features cols:', fcols.map((c: any) => c.column_name).join(', '));
    const ws = await sql`select distinct workspace_id from harness_shared.harness_registry limit 10`;
    console.log('registry workspaces:', ws.map((w: any) => w.workspace_id).join(', '));
  } finally {
    await sql.end();
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
