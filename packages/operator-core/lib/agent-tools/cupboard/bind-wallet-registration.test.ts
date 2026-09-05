import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

// The handler suite imports the leaf directly. This guard instead imports the
// exact production barrel, so deleting the index registration makes the test
// fail even while every leaf/transport test remains green.
import '../index';

describe('cupboard:bind-wallet production registration', () => {
  it('is reachable through the full agent-tools barrel', () => {
    expect(
      lookupByMcpName('cupboard:bind-wallet'),
      'cupboard:bind-wallet missing from packages/operator-core/lib/agent-tools/index.ts',
    ).toBeTruthy();
  });
});
