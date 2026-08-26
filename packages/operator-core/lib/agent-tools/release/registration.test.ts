import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

// The tool's unit suite imports the module directly, which would let an
// accidental omission from agent-tools/index.ts pass while every runtime
// surface remains unable to discover the tool. Load the real barrel here so
// this guard exercises the production registration path.
import '../index';

describe('release:repair-queue registration', () => {
  it('is reachable through the production agent-tools barrel', () => {
    expect(
      lookupByMcpName('release:repair-queue'),
      'release:repair-queue missing from the agent-tools projection registry',
    ).toBeTruthy();
  });
});
