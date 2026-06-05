/**
 * T4 mechanics probe (memory-backend-benchmark P-009) — scratch, delete in P-012.
 * Seeds the MEM02 gotcha through applyScenarioSetup (the real seam), then runs
 * the REAL injection path (buildMemoryContextBlock) with the MEM02 question as
 * queryContext, and checks the unknowable token surfaces. Cleans up after.
 */
import { applyScenarioSetup } from '@papercusp/operator-core/lib/llm-testing/setup';
import { buildMemoryContextBlock } from '@papercusp/operator-core/lib/memory/injection';
import { getMemoryBackend } from '@papercusp/operator-core/lib/memory/backend';

const backend = getMemoryBackend();
console.log('backend:', backend.name, JSON.stringify(await backend.available()));

const cleanup = await applyScenarioSetup(
  { mem0: [{ kind: 'project', body: 'The scratch-relay sidecar exits silently (code 0, nothing logged) when PAPERCUSP_RELAY_SALT is unset. Always export PAPERCUSP_RELAY_SALT before launching it — this is the first thing to check on a silent exit.' }] },
  { runId: 'probe-t4-mechanics' },
);

try {
  const block = await buildMemoryContextBlock({
    userId: null,
    workspaceId: 'default',
    harnessSlugs: ['papercup'],
    queryContext: 'the scratch-relay sidecar exits immediately after launch with exit code 0 and no error output — what should I check first?',
  });
  console.log('--- injected block ---');
  console.log(block ?? '(null)');
  console.log('--- verdict:', block?.includes('PAPERCUSP_RELAY_SALT') ? 'PROBE PASS' : 'PROBE FAIL');
} finally {
  await cleanup?.();
  console.log('cleanup done');
}
