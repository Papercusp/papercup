import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMachineCapabilityTagsCacheForTests,
  detectMachineCapabilityTags,
  getCachedMachineCapabilityTags,
} from './machine-capability-tags';

describe('detectMachineCapabilityTags (WI-1546, Gate DG-3 follow-up)', () => {
  it('always includes node, even when docker is unreachable', async () => {
    const tags = await detectMachineCapabilityTags({ probeDocker: async () => false });
    expect(tags).toEqual(['node']);
  });

  it('adds docker + pg together when the docker probe succeeds', async () => {
    const tags = await detectMachineCapabilityTags({ probeDocker: async () => true });
    expect(tags).toEqual(['node', 'docker', 'pg']);
  });

  it('fails closed (node only) when the docker probe throws', async () => {
    const tags = await detectMachineCapabilityTags({
      probeDocker: async () => {
        throw new Error('boom');
      },
    });
    expect(tags).toEqual(['node']);
  });
});

describe('getCachedMachineCapabilityTags — per-process memoization', () => {
  beforeEach(() => {
    __resetMachineCapabilityTagsCacheForTests();
  });

  it('only calls the probe once across repeated calls', async () => {
    let calls = 0;
    const probeDocker = async (): Promise<boolean> => {
      calls += 1;
      return true;
    };
    const first = await getCachedMachineCapabilityTags({ probeDocker });
    const second = await getCachedMachineCapabilityTags({ probeDocker });
    expect(first).toEqual(['node', 'docker', 'pg']);
    expect(second).toEqual(['node', 'docker', 'pg']);
    expect(calls).toBe(1);
  });

  it('a later call with different deps is ignored once cached (memoized on first call)', async () => {
    await getCachedMachineCapabilityTags({ probeDocker: async () => false });
    const second = await getCachedMachineCapabilityTags({ probeDocker: async () => true });
    expect(second).toEqual(['node']); // still the FIRST call's result
  });

  it('__resetMachineCapabilityTagsCacheForTests forces a fresh probe', async () => {
    await getCachedMachineCapabilityTags({ probeDocker: async () => false });
    __resetMachineCapabilityTagsCacheForTests();
    const afterReset = await getCachedMachineCapabilityTags({ probeDocker: async () => true });
    expect(afterReset).toEqual(['node', 'docker', 'pg']);
  });
});
