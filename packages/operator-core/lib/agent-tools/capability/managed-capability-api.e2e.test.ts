/** E14: real production MCP HTTP route with an owned private operator and PG. */
import { describe, it } from 'vitest';
import { recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { managedCapabilityApiProofOptions } from './_managed-capability-api-proof';

describe('managed capability E14 over the production HTTP route', () => {
  it('retains kernel/browser state, refuses foreign handles, preserves media and atomic patching, and cleans owned resources', async context => {
    const runId = await recordIsolatedIntegrationProof(managedCapabilityApiProofOptions(
      'packages/operator-core/lib/agent-tools/capability/managed-capability-api.e2e.test.ts'));
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_MANAGED_API_E14_PROOF_RUN ' + runId);
  }, 600_000);
});
