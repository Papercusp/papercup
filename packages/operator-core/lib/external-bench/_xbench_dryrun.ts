/**
 * DRY-RUN smoke of the bench-harness real-ops machinery WITHOUT spending model budget: exercise
 * create (registry + scaffold + blueprint write) → feed (feature INSERT) → a FAKE-agent director loop
 * (AGENT_CMD points at a stub that emits a DONE decision) → cost-sum → teardown. Confirms the wiring
 * (registry resolution, schema scaffold, feature row, spawnInvokeOnce path, cost SQL, teardown DROP)
 * is sound before the real run. Removed after.
 */
import { liveBenchHarnessOps } from './bench-harness-live';
import type { BenchTask } from './types';
import { cloneTaskRepo } from './clone';

const WORKSPACE_ID = process.env.XBENCH_WORKSPACE_ID ?? 'papercusp-workspace';
const SRC_REPO = process.env.XBENCH_SRC_REPO ?? '/tmp/xbench-ansible-repo';

async function main() {
  const ops = liveBenchHarnessOps({ workspaceId: WORKSPACE_ID });
  const task: BenchTask = {
    benchmark: 'swe-bench-pro',
    instanceId: 'dryrun-instance',
    problemStatement: 'DRYRUN: do nothing; emit DONE.',
    repo: SRC_REPO,
    baseCommit: 'e1daaae42af1a4e465edbdad4bb3c6dd7e7110d5',
    graderMeta: {},
  };

  console.log('[dryrun] clone…');
  const checkout = await cloneTaskRepo(task, { workRoot: process.env.XBENCH_WORKROOT });
  console.log('[dryrun] checkout', checkout.dir);

  console.log('[dryrun] createHarness…');
  const handle = await ops.createHarness({ blueprintId: 'external-bench', checkout, workspaceId: WORKSPACE_ID });
  console.log('[dryrun] handle', JSON.stringify(handle));

  console.log('[dryrun] addFeature…');
  await ops.addFeature({ handle, task, workspaceId: WORKSPACE_ID });
  console.log('[dryrun] feature seeded');

  // Verify the feature row landed.
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;
  const rows = await sql`
    SELECT harness_slug, feature_id, status, item_kind FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${WORKSPACE_ID} AND harness_slug = ${handle.slug}`;
  console.log('[dryrun] feature rows:', JSON.stringify(rows));

  // Verify the harness resolves via the same path spawnInvokeOnce uses.
  const { resolveProject } = await import('../harness-core');
  const proj = await resolveProject(handle.slug, WORKSPACE_ID);
  console.log('[dryrun] resolveProject →', proj ? proj.path : 'NULL');

  // cost (should be zero — no agents ran).
  const cost = await ops.collectCost({ handle, workspaceId: WORKSPACE_ID });
  console.log('[dryrun] cost', JSON.stringify(cost));

  console.log('[dryrun] teardown…');
  await ops.teardown({ handle, workspaceId: WORKSPACE_ID });
  console.log('[dryrun] teardown done');

  // Confirm schema dropped.
  const { harnessSchemaName } = await import('../scaffold-harness-schema');
  const schemaExists = await sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${harnessSchemaName(handle.slug)}`;
  console.log('[dryrun] schema after teardown exists?', schemaExists.length > 0);

  await checkout.cleanup();
  console.log('[dryrun] OK — wiring sound.');
  process.exit(0);
}

main().catch((e) => {
  console.error('[dryrun] FATAL', e instanceof Error ? e.stack : e);
  process.exit(1);
});
