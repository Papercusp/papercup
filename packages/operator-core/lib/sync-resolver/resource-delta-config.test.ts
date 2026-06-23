/**
 * resource-delta-config (agent-tool-delta-client-rollout-2026-06-23 P-006) — the per-sync-
 * resource itemKey config that opts a resource into the rows-delta protocol. Pins the two
 * configured high-cost resources + that an unconfigured one serves full (undefined).
 */
import { describe, it, expect } from 'vitest';
import { resourceDeltaConfig } from './resource-delta-config';

describe('resourceDeltaConfig', () => {
  it('plans.attention keys on the AttentionGroup `key`', () => {
    expect(resourceDeltaConfig('plans.attention')).toEqual({
      itemKeyField: 'key',
      schemaVersion: 'plans-attention-v1',
    });
  });

  it('plans.list keys on `slug`', () => {
    expect(resourceDeltaConfig('plans.list')?.itemKeyField).toBe('slug');
  });

  it('an unconfigured resource serves full (undefined → no delta)', () => {
    expect(resourceDeltaConfig('workItems.byHarness')).toBeUndefined();
  });
});
