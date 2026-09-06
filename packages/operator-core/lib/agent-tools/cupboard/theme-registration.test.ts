import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

// Import the production barrel, not the leaf modules. This catches an otherwise
// green theme implementation whose public agent doors were never registered.
import '../index';

describe('Cupboard theme agent-tool registration', () => {
  it.each(['cupboard:publish-theme', 'cupboard:install-theme'])('%s is reachable through the production catalog', (name) => {
    expect(
      lookupByMcpName(name),
      `${name} missing from packages/operator-core/lib/agent-tools/index.ts`,
    ).toBeTruthy();
  });
});
