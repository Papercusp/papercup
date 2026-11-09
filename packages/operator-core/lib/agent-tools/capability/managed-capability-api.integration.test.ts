/** Integration proof: actual HTTP MCP client, private operator identity and PostgreSQL. */
import { describe, it } from 'vitest';
import { recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';
import { managedCapabilityApiProofOptions } from './_managed-capability-api-proof';

describe('managed capability acceptance over the production HTTP route', () => {
  it('retains kernel/browser state across fresh clients and refuses PTY without a private session bus', async context => {
    const runId = await recordIsolatedIntegrationProof(managedCapabilityApiProofOptions(
      'packages/operator-core/lib/agent-tools/capability/managed-capability-api.integration.test.ts'));
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_MANAGED_API_PROOF_RUN ' + runId);
  }, 600_000);
});
