/* scratch probe — does the oracle's alive predicate see the zero-call population?
 * Deleted after the measurement; not a committed artifact. */
import { getOrgPg } from '@papercusp/db-org';
import { resolveSessionStates } from './packages/operator-core/lib/agent-tools/coordination/liveness-oracle';
import { holderCountsAsAlive } from './packages/operator-core/lib/goals/holder';

async function main() {
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      owner_id: string;
      owner_label: string;
      fleet_slug: string | null;
      heartbeat_at: string;
      host: string | null;
      pid: number | null;
      source: string;
      agent_role: string | null;
      age_min: string;
      any_calls: string;
      agent_calls: string;
    }[]
  >`
    WITH live AS (
      SELECT p.* FROM harness_shared.coord_presence p
       WHERE p.workspace_id = 'papercusp-workspace'
         AND p.heartbeat_at > now() - interval '5 minutes'
         AND p.started_at < now() - interval '15 minutes'
    )
    SELECT l.owner_id, l.owner_label, l.fleet_slug,
           l.heartbeat_at, l.host, l.pid, l.source, l.agent_role,
           round((EXTRACT(EPOCH FROM (now() - l.started_at))/60)::numeric,0)::text AS age_min,
           (SELECT count(*) FROM harness_shared.tool_invocations ti
             WHERE ti.coord_owner_id = l.owner_id
               AND ti.workspace_id = 'papercusp-workspace'
               AND ti.invoked_at >= l.started_at)::text AS any_calls,
           (SELECT count(*) FROM harness_shared.tool_invocations ti
             WHERE ti.coord_owner_id = l.owner_id
               AND ti.workspace_id = 'papercusp-workspace'
               AND ti.invoked_at >= l.started_at
               AND ti.call_origin IS DISTINCT FROM 'hook')::text AS agent_calls
      FROM live l`;

  const verdicts = await resolveSessionStates(
    rows.map((r) => ({
      ownerId: r.owner_id,
      heartbeatAt: r.heartbeat_at,
      host: r.host,
      pid: r.pid,
      source: r.source,
      agentRole: r.agent_role,
    })),
    { selfWake: true },
  );

  let pop = 0;
  const wedged: string[] = [];
  const bySelfWake = new Map<string, number>();
  for (const r of rows) {
    const v = verdicts.get(r.owner_id);
    const alive = v ? holderCountsAsAlive(v) : null;
    if (alive === true) pop += 1;
    if (alive === true && Number(r.agent_calls) === 0) {
      const phase = Number(r.any_calls) === 0 ? 'never-booted' : 'booted-never-worked';
      wedged.push(
        `${r.owner_label} fleet=${r.fleet_slug ?? '-'} age=${r.age_min}m ` +
          `state=${v?.sessionState} selfWake=${v?.selfWake} wakeable=${v?.wakeable} ` +
          `any=${r.any_calls} agent=${r.agent_calls} phase=${phase}`,
      );
    }
    const k = `${v?.sessionState}/${v?.selfWake}/alive=${alive}`;
    bySelfWake.set(k, (bySelfWake.get(k) ?? 0) + 1);
  }

  console.log(`presence rows past grace: ${rows.length}`);
  console.log(`counts-as-alive per oracle: ${pop}`);
  console.log(`WEDGED (alive + zero agent-origin calls): ${wedged.length}`);
  for (const w of wedged) console.log('  ' + w);
  console.log('--- state/selfWake distribution ---');
  for (const [k, n] of [...bySelfWake].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  await sql.end({ timeout: 2 });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
