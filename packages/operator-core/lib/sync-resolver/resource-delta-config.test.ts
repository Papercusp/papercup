/**
 * resource-delta-config (agent-tool-delta-client-rollout-2026-06-23 P-006) — the per-sync-
 * resource itemKey config that opts a resource into the rows-delta protocol. Pins the two
 * configured high-cost resources + that an unconfigured one serves full (undefined).
 */
import { describe, it, expect } from 'vitest';
import { resourceDeltaConfig } from './resource-delta-config';

describe('resourceDeltaConfig', () => {
  // The schemaVersion literal is pinned ON PURPOSE: changing the projected row
  // shape without bumping it makes in-flight client cursors report the whole
  // view as `updated` instead of taking one clean full. Failing here is the
  // reminder to bump — v1 → v2 was WI-7039/D-025 (null-valued keys omitted).
  it('plans.attention keys on the AttentionGroup `key`', () => {
    expect(resourceDeltaConfig('plans.attention')).toEqual({
      itemKeyField: 'key',
      schemaVersion: 'plans-attention-v2',
    });
  });

  it('plans.list keys on `slug`', () => {
    expect(resourceDeltaConfig('plans.list')?.itemKeyField).toBe('slug');
  });

  it('an unconfigured resource serves full (undefined → no delta)', () => {
    expect(resourceDeltaConfig('workItems.byHarness')).toBeUndefined();
  });
});
