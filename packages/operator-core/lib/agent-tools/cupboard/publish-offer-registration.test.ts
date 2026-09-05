import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

// The handler suite imports the leaf directly. This guard imports the exact
// production barrel, so deleting the index registration cannot leave a green
// but unreachable agent tool.
import '../index';

describe('cupboard:publish-offer production registration', () => {
  it('is reachable through the full agent-tools barrel', () => {
    expect(
      lookupByMcpName('cupboard:publish-offer'),
      'cupboard:publish-offer missing from packages/operator-core/lib/agent-tools/index.ts',
    ).toBeTruthy();
  });
});
