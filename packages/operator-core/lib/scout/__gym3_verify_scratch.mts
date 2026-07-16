import { refreshScoutOutcomes } from './routed-ledger';
import { getOrgPg } from '@papercusp/db-org';

async function main() {
  const WS = 'papercusp-workspace';
  const report = await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: 'papercusp' });
  console.log('report byLens summary:', JSON.stringify(Object.fromEntries(
    Object.entries(report.byLens).map(([l, s]) => [l, { won: s.won, lost: s.lost, pending: s.pending }]))
  ));

  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT rail, routed_ref, outcome, count(*) AS n
      FROM harness_shared.scout_routed_ideas
     WHERE workspace_id = ${WS}
       AND ((rail='gym' AND routed_ref IN ('gym:SP-001','gym:SP-002','gym:SP-003','gym:SP-004'))
         OR (rail='plan' AND routed_ref LIKE 'plan:scout-%'))
     GROUP BY 1,2,3
     ORDER BY 1,2`;
  console.log('POST-REFRESH outcomes:');
  for (const r of rows) console.log(JSON.stringify(r));
  process.exit(0);
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
