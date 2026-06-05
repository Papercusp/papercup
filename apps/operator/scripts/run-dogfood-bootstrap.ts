/**
 * One-shot driver for the P-014 + P-024 boot helpers. Validates them
 * against the live PG without restarting the user's running operator.
 *
 * What this does (same code paths instrumentation-node.ts runs on
 * every boot):
 *   1. ensurePapercuspWorkspace() — registry.json entry.
 *   2. registerPapercupHarness() — PG row in harness_shared.harness_registry
 *      scoped to the sentinel workspace.
 *
 * Run with:
 *   cd apps/operator && npx tsx scripts/run-dogfood-bootstrap.mts
 */

import { ensurePapercuspWorkspace, PAPERCUSP_WORKSPACE_ID } from '@papercusp/operator-core/lib/harness/papercusp-workspace';
import { registerPapercupHarness } from '@papercusp/operator-core/lib/harness/register-papercup';
import { loadHarnessRegistry } from '@papercusp/operator-core/lib/harness-registry';
import { readRegistry } from '@papercusp/operator-core/lib/workspace-registry';

async function main(): Promise<void> {
  console.log('=== STEP 1: ensurePapercuspWorkspace ===');
  const wsEntry = ensurePapercuspWorkspace();
  console.log(`workspace entry: id=${wsEntry.id}, name=${wsEntry.name}, createdAt=${wsEntry.createdAt}`);

  const reg = readRegistry();
  console.log(`workspaces total: ${reg.workspaces.length}, current: ${reg.current}`);
  const sentinelInList = reg.workspaces.find((w) => w.id === PAPERCUSP_WORKSPACE_ID);
  if (!sentinelInList) {
    console.error('FAIL: sentinel not in registry after ensure');
    process.exit(1);
  }
  console.log(`✓ sentinel '${PAPERCUSP_WORKSPACE_ID}' present in registry`);

  console.log('\n=== STEP 2: registerPapercupHarness ===');
  const result = await registerPapercupHarness();
  console.log(`state: ${result.state}`);
  console.log(`path: ${result.path ?? '(null)'}`);
  if (result.reason) console.log(`reason: ${result.reason}`);

  console.log('\n=== STEP 3: verify PG row ===');
  const hReg = await loadHarnessRegistry(PAPERCUSP_WORKSPACE_ID);
  console.log(`harness_registry@${PAPERCUSP_WORKSPACE_ID}: ${hReg.projects.length} projects`);
  for (const p of hReg.projects) {
    console.log(`  - ${p.slug}  →  ${p.path}`);
  }
  const papercup = hReg.projects.find((p) => p.slug === 'papercup');
  if (!papercup) {
    console.error('FAIL: papercup not in sentinel workspace registry');
    process.exit(1);
  }
  console.log(`✓ papercup registered in sentinel workspace`);

  console.log('\n=== PASS — dogfooding flipped on ===');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e?.stack ?? e);
  process.exit(1);
});
